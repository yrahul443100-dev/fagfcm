const admin = require("firebase-admin");
const express = require("express");
const app = express();

/**
 * --- CONFIGURATION ---
 * Ensure you set the FIREBASE_SERVICE_ACCOUNT environment variable on Render
 * with the contents of your Firebase Service Account JSON file.
 */
const dbURL = "https://fagboi-5b1c9-default-rtdb.firebaseio.com";
const saContent = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!saContent) {
  console.error("************************************************************");
  console.error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT is missing!");
  console.error("Action: Go to Render Dashboard -> Settings -> Environment Variables");
  console.error("Value: Paste your entire Firebase Service Account JSON here.");
  console.error("************************************************************");
  // We don't exit in development, but in production, this is a must-fix.
  if (process.env.NODE_ENV === 'production') process.exit(1);
}

try {
  const serviceAccount = JSON.parse(saContent || "{}");
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: dbURL
  });
  console.log("Firebase Admin Initialized Successfully. 🚀");
} catch (e) {
  console.error("FATAL ERROR: Invalid Service Account JSON:", e.message);
  if (process.env.NODE_ENV === 'production') process.exit(1);
}

const db = admin.database();

console.log("FCM High-Priority Server Monitoring fcm_queue...");

/**
 * Sends a single high-priority FCM message to wake up the target device.
 */
async function sendWakeupSignal(uid, token) {
  if (!token) {
    console.warn(`[SKIP] No registration token found for UID: ${uid}`);
    return;
  }

  const message = {
    token: token,
    // Data payload ensures the app's background listener is triggered
    data: {
      t: "WAKE_UP",
      ts: Date.now().toString(),
      p: "high"
    },
    android: {
      priority: "high", // Critical for waking from Doze mode
      ttl: 3600 * 1000 // 1 hour time-to-live
    }
  };

  try {
    const response = await admin.messaging().send(message);
    console.log(`[SUCCESS] High-priority signal delivered to ${uid}. ID: ${response}`);
  } catch (error) {
    console.error(`[CRITICAL] FCM Transmission Error for ${uid}:`, error.message);
    // If the token is invalid, you could optionally clean it up in your DB here
  }
}

/**
 * REALTIME QUEUE LISTENER
 * Monitors 'fcm_queue' for new requests.
 */
db.ref("fcm_queue").on("child_added", async (snapshot) => {
  const queueId = snapshot.key;
  const payload = snapshot.val();

  if (!payload || !payload.targetUid) {
    console.log(`[QUEUE] Invalid or empty request at ${queueId}. Deleting.`);
    return db.ref(`fcm_queue/${queueId}`).remove();
  }

  const targetUid = payload.targetUid;
  console.log(`[QUEUE] Triggering wakeup sequence for: ${targetUid}`);

  try {
    if (targetUid === "ALL") {
      // BROADCAST: Wake up every device registered in the Users node
      const usersSnap = await db.ref("Users").once("value");
      const users = usersSnap.val() || {};
      const uids = Object.keys(users);

      console.log(`[BROADCAST] Preparing wakeup batch for ${uids.length} potential devices...`);

      const messages = [];
      uids.forEach(uid => {
        const token = users[uid].I ? users[uid].I.tk : null;
        if (token) {
          messages.push({
            token: token,
            data: { t: "WAKE_UP", ts: Date.now().toString() },
            android: { priority: "high" }
          });
        }
      });

      if (messages.length > 0) {
        // Use sendEach for batch delivery (Firebase Admin v11.5.0+)
        const result = await admin.messaging().sendEach(messages);
        console.log(`[BROADCAST] Result -> Success: ${result.successCount}, Failure: ${result.failureCount}`);
      }
    } else {
      // TARGETED: Wake up a single specific device
      const userTokenSnap = await db.ref(`Users/${targetUid}/I/tk`).once("value");
      const token = userTokenSnap.val();
      await sendWakeupSignal(targetUid, token);
    }
  } catch (err) {
    console.error(`[ERROR] Processing queue task ${queueId}:`, err.message);
  } finally {
    // Delete the task from the queue once processed
    db.ref(`fcm_queue/${queueId}`).remove();
  }
});

/**
 * HEALTH CHECK & MONITORING
 * Required for Render to keep the service alive.
 */
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>BOI FCM Status: ONLINE</title>
        <style>
          body { font-family: -apple-system, sans-serif; background: #0f172a; color: white; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #1e293b; padding: 2.5rem; border-radius: 2rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); border: 1px solid #334155; text-align: center; }
          .status-dot { width: 12px; height: 12px; background: #10b981; border-radius: 50%; display: inline-block; margin-right: 8px; box-shadow: 0 0 15px #10b981; }
          h1 { margin: 0; font-size: 1.5rem; letter-spacing: -0.025em; }
          p { color: #94a3b8; font-size: 0.875rem; margin-top: 0.5rem; }
          code { background: #0f172a; padding: 0.2rem 0.5rem; border-radius: 0.4rem; color: #3b82f6; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="status-dot"></div>
          <h1>FCM Service Active</h1>
          <p>Target Database: <code>${dbURL}</code></p>
          <p style="font-size: 0.75rem; margin-top: 2rem; opacity: 0.5;">Listening for <b>fcm_queue</b> events...</p>
        </div>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SYSTEM] FCM Relay Node started on port ${PORT}`);
});
