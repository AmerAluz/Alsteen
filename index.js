// index.js
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');

const app = express();
app.use(bodyParser.json());

// --- Firebase Admin init ---
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://test-for-flutter-flow-default-rtdb.firebaseio.com',
});

const db = admin.firestore();
const rtdb = admin.database();

/* ===================== helpers ===================== */

function evaluateCondition(value, operator, target) {
  switch (operator) {
    case '==': return value == target;
    case '!=': return value != target;
    case '>':  return value >  target;
    case '<':  return value <  target;
    case '>=': return value >= target;
    case '<=': return value <= target;
    default:   return false;
  }
}

// تقسيم مصفوفة إلى دفعات بحجم ثابت (للإرسال المتعدد)
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// إرسال إشعار إلى مجموعة توكنات (يدعم دفعات 500)
async function sendToTokens(tokens, title, body) {
  // تنظيف وتفريد
  const clean = [...new Set(tokens.filter(t => typeof t === 'string' && t.trim().length > 0))];
  if (clean.length === 0) {
    console.warn('⚠️ لا توجد توكينات صالحة بعد التنظيف.');
    return;
  }

  const batches = chunk(clean, 500); // حد FCM
  let sent = 0, failed = 0;

  for (const tokensBatch of batches) {
    try {
      const res = await admin.messaging().sendEachForMulticast({
        tokens: tokensBatch,
        notification: { title, body },
      });
      sent  += res.successCount;
      failed += res.failureCount;

      // سجل الأخطاء المفيدة (مثلاً invalid-registration-token) — يمكن لاحقًا حذف التوكنات المعطوبة
      res.responses.forEach((r, idx) => {
        if (!r.success) {
          console.error(`❌ فشل إرسال إلى ${tokensBatch[idx]}: ${r.error?.code} | ${r.error?.message}`);
        }
      });
    } catch (err) {
      console.error('❌ خطأ أثناء sendEachForMulticast:', err.message);
    }
  }

  console.log(`📨 تم الإرسال: ${sent} ✔️ / فشل: ${failed} ✖️ (إجمالي مستهدف: ${clean.length})`);
}

// جلب توكنات مستخدم محدد بالـ uid أو email
async function getUserDeviceTokensByTarget({ targetUid, targetEmail }) {
  try {
    let userDocSnap = null;

    if (targetUid) {
      userDocSnap = await db.collection('users').doc(targetUid).get();
      if (!userDocSnap.exists) {
        console.warn(`⚠️ لم يتم العثور على مستخدم بالـ uid: ${targetUid}`);
        return [];
      }
    } else if (targetEmail) {
      const q = await db.collection('users')
        .where('email', '==', targetEmail)
        .limit(1)
        .get();
      if (q.empty) {
        console.warn(`⚠️ لم يتم العثور على مستخدم بالإيميل: ${targetEmail}`);
        return [];
      }
      userDocSnap = q.docs[0];
    } else {
      // لا هدف — سيُستخدم برودكاست لاحقًا
      return [];
    }

    const tokens = userDocSnap.data()?.device_tokens || [];
    if (!Array.isArray(tokens) || tokens.length === 0) {
      console.warn('⚠️ لا توجد device_tokens للمستخدم.');
      return [];
    }
    return tokens;
  } catch (e) {
    console.error('❌ خطأ في جلب device_tokens:', e.message);
    return [];
  }
}

// جلب كل التوكنات من جميع المستخدمين (برودكاست)
async function getAllDeviceTokens() {
  try {
    const snap = await db.collection('users').get();
    if (snap.empty) return [];

    const all = [];
    snap.forEach(doc => {
      const arr = doc.data()?.device_tokens;
      if (Array.isArray(arr)) all.push(...arr);
    });
    return all;
  } catch (e) {
    console.error('❌ خطأ في جلب كل device_tokens:', e.message);
    return [];
  }
}

/* ===================== main watcher ===================== */

async function setupAutomationListeners() {
  const snapshot = await db.collection('automations').get();
  if (snapshot.empty) {
    console.log('ℹ️ لا توجد مهام automations.');
    return;
  }

  snapshot.forEach(doc => {
    const data = doc.data();

    const actionType   = data?.action?.type;
    const title        = data?.action?.payload?.title || 'Notification';
    const text         = data?.action?.payload?.text  || '';

    const operator     = data?.condition?.operator;
    const rtdbPath     = data?.condition?.path;    // مثال: "Nomber" أو "Amr/Hum"
    const source       = data?.condition?.source;  // يجب أن يكون "firebase_rtdb"
    const targetValue  = data?.condition?.value;

    const targetUid    = data?.target_uid || null;
    const targetEmail  = data?.target_email || null;

    if (actionType !== 'notification') {
      console.log(`↩️ المهمة ${doc.id}: action.type ليس "notification" — تم التخطي.`);
      return;
    }
    if (source !== 'firebase_rtdb') {
      console.log(`↩️ المهمة ${doc.id}: source ليس "firebase_rtdb" — تم التخطي.`);
      return;
    }
    if (!rtdbPath || !operator || typeof targetValue === 'undefined') {
      console.log(`↩️ المهمة ${doc.id}: حقول condition ناقصة — تم التخطي.`);
      return;
    }

    const ref = rtdb.ref(rtdbPath);
    ref.on('value', async snap => {
      const current = snap.val();

      if (evaluateCondition(current, operator, targetValue)) {
        console.log(`🚨 تحقّق الشرط للمهمة ${doc.id} على ${rtdbPath}:`, current);

        // إن لم يوجد هدف محدد ⇒ برودكاست
        let tokens = [];
        if (targetUid || targetEmail) {
          tokens = await getUserDeviceTokensByTarget({ targetUid, targetEmail });
          if (tokens.length === 0) {
            console.warn('⚠️ لا توجد توكينات للمستخدم الهدف — لن يتم الإرسال.');
            return;
          }
        } else {
          console.warn('ℹ️ لا يوجد target_uid/target_email — سيتم الإرسال كبرودكاست لجميع المستخدمين.');
          tokens = await getAllDeviceTokens();
          if (tokens.length === 0) {
            console.warn('⚠️ لا توجد توكينات لدى أي مستخدم — لن يتم الإرسال.');
            return;
          }
        }

        await sendToTokens(tokens, title, text);
      }
    });

    console.log(`📡 بدأنا نراقب "${rtdbPath}" للمهمة ${doc.id}`);
  });
}

/* ===================== health/test endpoints ===================== */

app.get('/check-firestore', async (_req, res) => {
  try {
    const snapshot = await db.collection('automations').get();
    const data = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ automations: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/check-rtdb', async (_req, res) => {
  try {
    const snapshot = await rtdb.ref('/Amr/Hum').once('value');
    res.json({ value: snapshot.val() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===================== start server ===================== */

app.listen(3000, () => {
  console.log('✅ Server running at http://localhost:3000');
  setupAutomationListeners().catch(err =>
    console.error('❌ setupAutomationListeners error:', err)
  );
});
