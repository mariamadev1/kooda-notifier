const { initializeApp, cert } = require("firebase-admin/app");
const {
  getFirestore,
  Timestamp,
  FieldValue,
  FieldPath,
} = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const crypto = require("crypto");

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT manquant");
  process.exit(1);
}
initializeApp({ credential: cert(JSON.parse(raw)) });
const db = getFirestore();

const DRY = !!process.env.DRY_RUN; // DRY_RUN=1 : affiche sans rien envoyer
const TZ = "Europe/Zurich";
const LATE_MIN = Number(process.env.LATE_MINUTES || 120); // rattrapage max

const HOUR = 3600 * 1000;
const REMINDERS = {
  oneWeekBefore: { ms: 7 * 24 * HOUR, label: "Dans 1 semaine" },
  threeDaysBefore: { ms: 3 * 24 * HOUR, label: "Dans 3 jours" },
  twoDaysBefore: { ms: 2 * 24 * HOUR, label: "Dans 2 jours" },
  oneDayBefore: { ms: 24 * HOUR, label: "Demain" },
  twoHoursBefore: { ms: 2 * HOUR, label: "Dans 2 heures" },
};
const EMOJI = { homework: "📚", evaluation: "📝", event: "🎉" };
const ADMIN_KEYS = ["creatorUid", "createdBy", "adminUid", "ownerUid", "admin"];

// ───────── Outils ─────────

function whenText(date) {
  const day = new Intl.DateTimeFormat("fr-CH", {
    timeZone: TZ, weekday: "long", day: "numeric", month: "long",
  }).format(date);
  const hm = new Intl.DateTimeFormat("fr-CH", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit",
  }).format(date);
  return `${day} à ${hm}`;
}

function bodyFor(key, startMs, nowMs) {
  const when = whenText(new Date(startMs));
  if (key === "twoHoursBefore") {
    // Si le rappel part en retard, on affiche le temps réellement restant
    const mins = Math.max(1, Math.round((startMs - nowMs) / 60000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const rel = h
      ? `Dans ${h} h${m ? ` ${String(m).padStart(2, "0")}` : ""}`
      : `Dans ${m} min`;
    return `${rel} · ${when}`;
  }
  return `${REMINDERS[key].label} · ${when}`;
}

// Même règle que UserStructure.canSee côté Flutter
function canSee(structures, target) {
  const gid = target[1];
  const a = structures && structures[gid];
  if (!a) return true; // ancien compte sans sélection : tout visible
  const partial = a.mode === "partial";
  const subs = a.sub_groups || [];
  const halves = a.half_sub_groups || [];
  if (target.length === 2) return !partial;
  if (target.length === 4) return subs.includes(target[3]);
  if (target.length >= 6) {
    return subs.includes(target[3]) && halves.includes(target[5]);
  }
  return true;
}

// ───────── Utilisateurs (avec cache pour la durée d'une exécution) ─────────

const userCache = new Map(); // uid -> données | null
const audienceCache = new Map(); // gid -> Set d'uid

async function loadUsers(uids) {
  const missing = uids.filter((u) => !userCache.has(u));
  if (missing.length) {
    const docs = await db.getAll(...missing.map((u) => db.doc(`users/${u}`)));
    docs.forEach((d) => userCache.set(d.id, d.exists ? d.data() : null));
  }
  return uids
    .map((u) => (userCache.get(u) ? { uid: u, data: userCache.get(u) } : null))
    .filter(Boolean)
    .filter(
      (u) =>
        u.data.notificationsEnabled !== false &&
        Array.isArray(u.data.fcmTokens) &&
        u.data.fcmTokens.length > 0,
    );
}

async function audienceOf(gid) {
  if (audienceCache.has(gid)) return audienceCache.get(gid);
  const ids = new Set();
  (await db.collection(`groups/${gid}/members`).get()).forEach((m) =>
    ids.add(m.id),
  );
  (
    await db
      .collection("users")
      .where(new FieldPath("myStructures", gid, "mode"), "==", "partial")
      .get()
  ).forEach((u) => ids.add(u.id));
  audienceCache.set(gid, ids);
  return ids;
}

// Qui est concerné par un devoir ?
async function recipientsOf(path) {
  const seg = path.split("/");
  if (seg[0] === "users") return loadUsers([seg[1]]); // devoir personnel

  const gid = seg[1];
  const target = seg.slice(0, -2); // groups/G[/sub_groups/S[/half_sub_groups/H]]
  const users = await loadUsers([...(await audienceOf(gid))]);
  return users.filter((u) => canSee(u.data.myStructures, target));
}

async function pushTo(users, notification, data) {
  const owner = new Map(); // jeton -> uid
  for (const u of users) for (const t of u.data.fcmTokens) owner.set(t, u.uid);
  const tokens = [...owner.keys()];
  const dead = [];

  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const res = await getMessaging().sendEachForMulticast({
      tokens: chunk,
      notification,
      data,
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default" } } },
    });
    res.responses.forEach((r, idx) => {
      const code = r.error && r.error.code;
      if (
        !r.success &&
        (code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token")
      ) {
        dead.push(chunk[idx]);
      } else if (!r.success) {
        console.warn("⚠️ Envoi en échec :", code);
      }
    });
  }
  // Nettoie les appareils qui n'existent plus
  for (const t of dead) {
    await db
      .doc(`users/${owner.get(t)}`)
      .update({ fcmTokens: FieldValue.arrayRemove(t) })
      .catch(() => {});
  }
  return tokens.length;
}

// ───────── 1. Rappels de devoirs ─────────

async function findDue(now) {
  const due = [];
  for (const [key, def] of Object.entries(REMINDERS)) {
    // Le rappel est dû si start - délai est dans [now - rattrapage, now]
    const from = Timestamp.fromMillis(now + def.ms - LATE_MIN * 60000);
    const to = Timestamp.fromMillis(now + def.ms);
    for (const col of ["homeworks", "individual_homeworks"]) {
      const snap = await db
        .collectionGroup(col)
        .where("start", ">=", from)
        .where("start", "<=", to)
        .get();
      for (const doc of snap.docs) {
        const d = doc.data();
        if (!(d.reminders && d.reminders[key])) continue; // rappel non activé
        if (!d.start || typeof d.start.toMillis !== "function") continue;
        due.push({ path: doc.ref.path, key, data: d, startMs: d.start.toMillis() });
      }
    }
  }
  return due;
}

async function processReminders(now) {
  const due = await findDue(now);
  console.log(`⏰ ${due.length} rappel(s) à traiter`);

  for (const r of due) {
    if (r.startMs <= now) continue; // le devoir est déjà passé

    const id = crypto
      .createHash("sha1")
      .update(`${r.path}|${r.key}|${r.startMs}`)
      .digest("hex");
    const claim = db.doc(`sentReminders/${id}`);

    if (!DRY) {
      // Réserve le rappel : échoue s'il a déjà été envoyé
      try {
        await claim.create({
          path: r.path,
          key: r.key,
          sentAt: Timestamp.now(),
          expireAt: Timestamp.fromMillis(r.startMs + 24 * HOUR),
        });
      } catch (e) {
        if (e.code === 6 || /ALREADY_EXISTS/.test(String(e))) continue;
        throw e;
      }
    }

    try {
      const users = await recipientsOf(r.path);
      const notification = {
        title: `${EMOJI[r.data.type] || "📚"} ${r.data.subject || "Devoir"} · ${r.data.title}`,
        body: bodyFor(r.key, r.startMs, now),
      };
      if (DRY) {
        console.log(`[DRY] ${r.path} (${r.key}) → ${users.length} personne(s) :`, notification);
        continue;
      }
      const n = await pushTo(users, notification, {
        type: "reminder",
        homeworkPath: r.path,
      });
      console.log(`✅ ${r.path} (${r.key}) → ${n} appareil(s)`);
    } catch (e) {
      // Échec complet : on libère la réservation pour réessayer au prochain tour
      if (!DRY) await claim.delete().catch(() => {});
      console.error("❌ Rappel en échec", r.path, e);
    }
  }
}

// ───────── 2. Message à l'admin quand quelqu'un rejoint un groupe ─────────

async function processJoins() {
  const snap = await db
    .collectionGroup("members")
    .where("announce", "==", true)
    .get();
  console.log(`👋 ${snap.size} nouveau(x) membre(s) à annoncer`);

  for (const doc of snap.docs) {
    const seg = doc.ref.path.split("/");
    if (seg.length !== 4 || seg[0] !== "groups") continue; // groups/G/members/U
    const gid = seg[1];
    const uid = seg[3];
    const m = doc.data();

    if (!DRY) await doc.ref.update({ announce: false }); // une seule annonce

    const g = await db.doc(`groups/${gid}`).get();
    if (!g.exists) continue;
    const gd = g.data();

    const admins = new Set();
    for (const k of ADMIN_KEYS) {
      if (typeof gd[k] === "string" && gd[k]) admins.add(gd[k]);
    }
    if (Array.isArray(gd.admins)) gd.admins.forEach((a) => admins.add(String(a)));
    admins.delete(uid); // l'admin qui s'inscrit lui-même
    if (admins.size === 0) continue;

    let name = m.pseudo;
    if (!name) {
      const u = await db.doc(`users/${uid}`).get();
      name = u.exists ? u.data().pseudo : null;
    }

    const users = await loadUsers([...admins]);
    const notification = {
      title: "👋 Nouveau membre",
      body: `${name || "Un nouvel élève"} a rejoint « ${gd.name || "ton groupe"} »`,
    };
    if (DRY) {
      console.log(`[DRY] admin(s) ${[...admins]} :`, notification);
      continue;
    }
    await pushTo(users, notification, { type: "member_joined", groupId: gid });
    console.log(`✅ Admin prévenu pour ${gid}`);
  }
}

// ───────── 3. Nettoyage des réservations expirées ─────────

async function cleanup() {
  const snap = await db
    .collection("sentReminders")
    .where("expireAt", "<", Timestamp.now())
    .limit(300)
    .get();
  if (snap.empty || DRY) return;
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

// ───────── Lancement ─────────

(async () => {
  const now = Date.now();
  let failed = false;
  for (const step of [() => processReminders(now), processJoins, cleanup]) {
    try {
      await step();
    } catch (e) {
      failed = true;
      console.error("❌", e);
    }
  }
  process.exit(failed ? 1 : 0);
})();
