/**
 * Meteo Lamera — Script notifiche push
 * Eseguito da GitHub Actions:
 *   - Ogni sera alle 20:30 (18:30 UTC): invia meteo del giorno dopo
 *   - Ogni ora 6-22: controlla eventi estremi e notifica se necessario
 */

import admin from 'firebase-admin';
import fetch from 'node-fetch';

// ── CONFIGURAZIONE ────────────────────────────────────────────────────
const PROJECT_ID     = process.env.FIREBASE_PROJECT_ID;
const CLIENT_EMAIL   = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY    = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

// Coordinate di default (Saronno) — lo script legge anche le città salvate dai token
const DEFAULT_LAT = 45.6254;
const DEFAULT_LON = 9.0346;

// Soglie eventi estremi
const SOGLIE = {
  pioggia_intensa:   70,   // % probabilità pioggia con codice >= 65
  temporale:         50,   // % probabilità con codice >= 95
  grandine:          40,   // % probabilità con codice 96 o 99
  neve:              60,   // % probabilità con codice >= 71
  vento_forte:       60,   // km/h
  caldo_estremo:     38,   // °C
  freddo_estremo:    -3,   // °C
};

// ── INIT FIREBASE ─────────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   PROJECT_ID,
    clientEmail: CLIENT_EMAIL,
    privateKey:  PRIVATE_KEY,
  }),
});
const db = admin.firestore();
const messaging = admin.messaging();

// ── UTILS ─────────────────────────────────────────────────────────────
function wmoLabel(code) {
  if (code === 0)  return 'Sereno ☀️';
  if (code <= 2)   return 'Poco nuvoloso 🌤';
  if (code === 3)  return 'Coperto ☁️';
  if (code <= 48)  return 'Nebbia 🌫️';
  if (code <= 57)  return 'Pioggerella 🌦️';
  if (code <= 67)  return 'Pioggia 🌧️';
  if (code <= 77)  return 'Neve ❄️';
  if (code <= 82)  return 'Rovesci 🌧️';
  if (code <= 86)  return 'Neve intensa ❄️';
  if (code <= 99)  return 'Temporale ⛈️';
  return 'Variabile';
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const giorni = ['domenica','lunedì','martedì','mercoledì','giovedì','venerdì','sabato'];
  const mesi   = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  return `${giorni[d.getDay()]} ${d.getDate()} ${mesi[d.getMonth()]}`;
}

// ── FETCH METEO ───────────────────────────────────────────────────────
async function fetchMeteo(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${lat}&longitude=${lon}`
    + `&hourly=temperature_2m,precipitation_probability,weathercode,windspeed_10m`
    + `&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max`
    + `&forecast_days=3&timezone=Europe%2FRome`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Open-Meteo error ' + r.status);
  return r.json();
}

// ── LEGGI TOKEN FCM DA FIRESTORE ──────────────────────────────────────
async function getTokens() {
  const snap = await db.collection('fcm_tokens').get();
  if (snap.empty) { console.log('Nessun token FCM registrato.'); return []; }
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── RIMUOVI TOKEN NON VALIDI ──────────────────────────────────────────
async function removeInvalidToken(tokenId) {
  await db.collection('fcm_tokens').doc(tokenId).delete();
  console.log(`Token rimosso: ${tokenId}`);
}

// ── INVIA NOTIFICA FCM ────────────────────────────────────────────────
async function sendPush(token, title, body, data = {}) {
  try {
    await messaging.send({
      token: token.token,
      notification: { title, body },
      data: { ...data, url: 'https://slammix1559.github.io/Lamera-Meteo/' },
      webpush: {
        headers: { Urgency: 'high' },
        notification: {
          title,
          body,
          icon: '/Lamera-Meteo/icons/icon-192.png',
          badge: '/Lamera-Meteo/icons/icon-192.png',
          vibrate: [200, 100, 200],
          requireInteraction: data.extreme === 'true',
        },
        fcmOptions: { link: 'https://slammix1559.github.io/Lamera-Meteo/' },
      },
    });
    console.log(`✅ Push inviata a ${token.city || 'dispositivo'}`);
  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered' ||
        err.code === 'messaging/invalid-registration-token') {
      await removeInvalidToken(token.id);
    } else {
      console.error(`❌ Errore push:`, err.message);
    }
  }
}

// ── NOTIFICA SERALE (20:30) ───────────────────────────────────────────
async function notificaSerale(tokens) {
  console.log('📅 Esecuzione notifica serale meteo di domani...');

  for (const token of tokens) {
    const lat  = token.lat  || DEFAULT_LAT;
    const lon  = token.lon  || DEFAULT_LON;
    const city = token.city || 'la tua città';

    try {
      const data = await fetchMeteo(lat, lon);

      // Domani = indice 1
      const domaniDate  = data.daily.time[1];
      const maxT        = Math.round(data.daily.temperature_2m_max[1]);
      const minT        = Math.round(data.daily.temperature_2m_min[1]);
      const code        = data.daily.weathercode[1];
      const rainProb    = Math.round(data.daily.precipitation_probability_max[1] || 0);
      const label       = wmoLabel(code);
      const dateLabel   = formatDate(domaniDate);

      // Costruisci messaggio
      let body = `${label} · Max ${maxT}°C / Min ${minT}°C`;
      if (rainProb > 20) body += ` · 💧 Pioggia ${rainProb}%`;

      // Aggiungi avvisi speciali
      const avvisi = [];
      if (maxT >= SOGLIE.caldo_estremo)  avvisi.push(`⚠️ Caldo estremo (${maxT}°C)`);
      if (minT <= SOGLIE.freddo_estremo) avvisi.push(`⚠️ Gelo notturno (${minT}°C)`);
      if (code >= 95)                    avvisi.push('⛈️ Temporali previsti');
      if (code >= 71 && code <= 77)      avvisi.push('❄️ Neve prevista');
      if (avvisi.length) body += '\n' + avvisi.join(' · ');

      await sendPush(
        token,
        `🌤 Meteo ${city} — ${dateLabel}`,
        body,
        { type: 'daily' }
      );
    } catch (err) {
      console.error(`Errore meteo per ${city}:`, err.message);
    }

    // Pausa tra token per non superare rate limit FCM
    await new Promise(r => setTimeout(r, 200));
  }
}

// ── CONTROLLO EVENTI ESTREMI ──────────────────────────────────────────
async function controlloEventiEstremi(tokens) {
  console.log('⚡ Controllo eventi estremi...');

  // Legge l'ultima notifica estrema inviata per evitare duplicati
  const lockRef  = db.collection('_notify_lock').doc('extreme');
  const lockSnap = await lockRef.get();
  const lastSent = lockSnap.exists ? lockSnap.data() : {};

  const now     = new Date();
  const nowKey  = now.toISOString().slice(0, 13); // es. "2026-06-23T09"

  for (const token of tokens) {
    const lat  = token.lat  || DEFAULT_LAT;
    const lon  = token.lon  || DEFAULT_LON;
    const city = token.city || 'la tua città';
    const lockKey = `${token.id}_${nowKey}`;

    // Già notificato questa ora per questo token
    if (lastSent[lockKey]) {
      console.log(`Skip ${city} — già notificato alle ${nowKey}`);
      continue;
    }

    try {
      const data = await fetchMeteo(lat, lon);
      const times = data.hourly.time;
      const nowIso = now.toISOString().slice(0, 13);

      // Controlla le prossime 3 ore
      const eventiTrovati = [];

      for (let h = 0; h < 3; h++) {
        const targetKey = new Date(now.getTime() + h * 3600000).toISOString().slice(0, 13);
        const idx = times.findIndex(t => t.slice(0, 13) === targetKey);
        if (idx < 0) continue;

        const temp    = data.hourly.temperature_2m[idx];
        const prob    = data.hourly.precipitation_probability[idx] || 0;
        const code    = data.hourly.weathercode[idx];
        const wind    = data.hourly.windspeed_10m[idx] || 0;
        const hLabel  = targetKey.slice(11, 13) + ':00';

        // Temporale
        if (code >= 95 && prob >= SOGLIE.temporale) {
          eventiTrovati.push(`⛈️ Temporale alle ${hLabel} (${prob}%)`);
        }
        // Grandine
        if ((code === 96 || code === 99) && prob >= SOGLIE.grandine) {
          eventiTrovati.push(`🌨️ Grandine alle ${hLabel} (${prob}%)`);
        }
        // Pioggia intensa
        if (code >= 65 && code <= 67 && prob >= SOGLIE.pioggia_intensa) {
          eventiTrovati.push(`🌧️ Pioggia intensa alle ${hLabel} (${prob}%)`);
        }
        // Neve
        if (code >= 71 && code <= 77 && prob >= SOGLIE.neve) {
          eventiTrovati.push(`❄️ Neve alle ${hLabel} (${prob}%)`);
        }
        // Vento forte
        if (wind >= SOGLIE.vento_forte) {
          eventiTrovati.push(`💨 Vento forte alle ${hLabel} (${Math.round(wind)} km/h)`);
        }
        // Caldo estremo
        if (temp >= SOGLIE.caldo_estremo && h === 0) {
          eventiTrovati.push(`🌡️ Caldo estremo: ${Math.round(temp)}°C`);
        }
      }

      if (eventiTrovati.length > 0) {
        const title = `⚠️ Allerta Meteo — ${city}`;
        const body  = eventiTrovati.join('\n');
        await sendPush(token, title, body, { type: 'extreme', extreme: 'true' });

        // Salva lock per non inviare di nuovo questa ora
        lastSent[lockKey] = true;
      } else {
        console.log(`✓ Nessun evento estremo per ${city}`);
      }
    } catch (err) {
      console.error(`Errore controllo estremi per ${city}:`, err.message);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  // Salva i lock aggiornati (pulisce chiavi vecchie di più di 2 ore)
  const cleanedLock = {};
  const twoHoursAgo = new Date(now.getTime() - 2 * 3600000).toISOString().slice(0, 13);
  Object.keys(lastSent).forEach(k => {
    const keyHour = k.split('_').pop();
    if (keyHour >= twoHoursAgo) cleanedLock[k] = true;
  });
  await lockRef.set(cleanedLock);
}

// ── MAIN ──────────────────────────────────────────────────────────────
async function main() {
  const tokens = await getTokens();
  if (!tokens.length) {
    console.log('Nessun dispositivo registrato, uscita.');
    process.exit(0);
  }
  console.log(`📱 ${tokens.length} dispositivi registrati`);

  // Determina ora UTC corrente
  const nowUTC = new Date();
  const hourUTC = nowUTC.getUTCHours();
  const minUTC  = nowUTC.getUTCMinutes();

  // 18:30 UTC = 20:30 CEST (estate) → notifica serale
  const isSerale = hourUTC === 18 && minUTC >= 25 && minUTC <= 35;

  if (isSerale) {
    await notificaSerale(tokens);
  } else {
    await controlloEventiEstremi(tokens);
  }

  console.log('✅ Script completato.');
  process.exit(0);
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exit(1);
});
