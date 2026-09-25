// Conexión con Firebase: inicio de sesión (correo y contraseña) y base de datos Firestore.
// Cada usuario solo ve lo suyo: users/{uid}/receipts y users/{uid}/photos.
// Las fotos se guardan comprimidas dentro de Firestore para no necesitar el plan de pago de Storage.
import { FIREBASE_CONFIG } from "./firebase-config.js?v=7";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signOut, setPersistence, indexedDBLocalPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  collection, doc, setDoc, deleteDoc, getDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const configured = FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && !/PEGA/.test(FIREBASE_CONFIG.apiKey);

let Cloud;
if (!configured) {
  Cloud = { configured: false };
} else {
  const app = initializeApp(FIREBASE_CONFIG);
  const auth = getAuth(app);
  try { await setPersistence(auth, indexedDBLocalPersistence); } catch (e) { await setPersistence(auth, browserLocalPersistence).catch(() => {}); }
  let db;
  try {
    // copia local para que funcione sin internet y sincronice al volver la conexión
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (e) {
    db = initializeFirestore(app, { localCache: memoryLocalCache() });
  }
  const uid = () => auth.currentUser?.uid;
  const rcol = () => collection(db, "users", uid(), "receipts");
  const pdoc = id => doc(db, "users", uid(), "photos", id);

  const blobToDataURL = b => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });

  Cloud = {
    configured: true,
    get user() { return auth.currentUser; },
    onAuth: cb => onAuthStateChanged(auth, cb),
    signIn: (email, pw) => signInWithEmailAndPassword(auth, email, pw),
    signUp: (email, pw) => createUserWithEmailAndPassword(auth, email, pw),
    reset: email => sendPasswordResetEmail(auth, email),
    signOut: () => signOut(auth),
    watchReceipts: (cb, onErr) => onSnapshot(rcol(), snap => cb(snap.docs.map(d => ({ ...d.data(), id: d.id }))), onErr),
    // Firestore confirma en segundo plano: sin internet, el cambio queda guardado en el celular y se sube después
    put: r => { setDoc(doc(rcol(), r.id), JSON.parse(JSON.stringify(r))).catch(e => console.warn(e)); return Promise.resolve(); },
    del: id => { deleteDoc(doc(rcol(), id)).catch(e => console.warn(e)); return Promise.resolve(); },
    putPhoto: async (id, blob) => { const data = await blobToDataURL(blob); setDoc(pdoc(id), { data }).catch(e => console.warn(e)); },
    getPhoto: async id => { const s = await getDoc(pdoc(id)); if (!s.exists()) return null; return (await fetch(s.data().data)).blob(); },
    delPhoto: id => { deleteDoc(pdoc(id)).catch(e => console.warn(e)); return Promise.resolve(); },
  };
}
window.Cloud = Cloud;
window._cloudResolve(Cloud);
