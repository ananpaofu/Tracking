/* Firebase 云端好友与聊天模块（Storage Organizer v2.0）
   负责：匿名登录、全局唯一编号、好友申请、好友关系、实时聊天。
   仅处理「好友 / 聊天」数据，本地物品等数据仍存 localStorage。 */
(function (global) {
  'use strict';

  const CFG = {
    apiKey: 'AIzaSyApUn5ctaAs2m7lp1R7RBfryuj_tXk0FE',
    authDomain: 'tracker-chat-ce8d2.firebaseapp.com',
    projectId: 'tracker-chat-ce8d2',
    storageBucket: 'tracker-chat-ce8d2.firebasestorage.app',
    messagingSenderId: '712860064703',
    appId: '1:712860064703:web:3a04793e001f59a4719f0a',
    measurementId: 'G-DNMBZLJ392'
  };

  let app = null, auth = null, db = null, uid = null, profile = null;
  let enabled = false;
  const unsub = { requests: null, sent: null, friends: null, messages: {} };
  const cache = { requests: [], sent: [], friends: [], messages: {} };

  function rand6() { return String(Math.floor(100000 + Math.random() * 900000)); }

  function notify(type) {
    if (typeof global.__cloudOnChange === 'function') {
      try { global.__cloudOnChange(type); } catch (e) { console.warn(e); }
    }
  }

  function pairKey(a, b) { return [a, b].sort().join('_'); }

  function readUser(friendUid) {
    return db.collection('users').doc(friendUid).get().then(function (d) {
      return d.exists ? Object.assign({ uid: friendUid }, d.data()) : null;
    });
  }

  function ensureProfile() {
    return db.collection('users').doc(uid).get().then(function (doc) {
      if (doc.exists) { profile = doc.data(); return profile; }
      let fid = rand6();
      const tryUnique = function (attempt) {
        return db.collection('users').where('friendId', '==', fid).get().then(function (q) {
          if (!q.empty && attempt < 12) { fid = rand6(); return tryUnique(attempt + 1); }
          profile = { friendId: fid, name: '收纳用户', bio: '', avatar: '', createdAt: Date.now() };
          return db.collection('users').doc(uid).set(profile).then(function () { return profile; });
        });
      };
      return tryUnique(0);
    });
  }

  const ready = (function () {
    if (typeof global.firebase === 'undefined') {
      return Promise.resolve(false);
    }
    try {
      app = global.firebase.apps.length ? global.firebase.app() : global.firebase.initializeApp(CFG);
      auth = global.firebase.auth();
      db = global.firebase.firestore();
      return auth.signInAnonymously().then(function (cred) {
        uid = cred.user.uid;
        return ensureProfile();
      }).then(function () {
        enabled = true;
        startListeners();
        return true;
      }).catch(function (e) {
        console.warn('[Cloud] init failed:', e);
        enabled = false;
        return false;
      });
    } catch (e) {
      console.warn('[Cloud] setup failed:', e);
      return Promise.resolve(false);
    }
  })();

  function startListeners() {
    // 收到的好友申请
    unsub.requests = db.collection('friendRequests').where('toUid', '==', uid)
      .onSnapshot(function (snap) {
        cache.requests = [];
        snap.forEach(function (d) {
          const r = d.data();
          if (r.status === 'pending') cache.requests.push(Object.assign({ id: d.id }, r));
        });
        notify('requests');
      });
    // 我发出的申请
    unsub.sent = db.collection('friendRequests').where('fromUid', '==', uid)
      .onSnapshot(function (snap) {
        cache.sent = [];
        snap.forEach(function (d) {
          const r = d.data();
          cache.sent.push(Object.assign({ id: d.id }, r));
        });
        notify('sent');
      });
    // 好友列表
    unsub.friends = db.collection('friends').doc(uid).collection('contacts')
      .onSnapshot(function (snap) {
        const uids = [];
        snap.forEach(function (d) { uids.push(d.id); });
        Promise.all(uids.map(readUser)).then(function (list) {
          cache.friends = list.filter(Boolean);
          notify('friends');
        });
      });
  }

  const Cloud = {
    ready: ready,
    isEnabled: function () { return enabled; },
    myUid: function () { return uid; },
    myFriendId: function () { return profile ? profile.friendId : ''; },
    myProfile: function () { return profile || {}; },

    updateProfile: function (patch) {
      if (!enabled) return Promise.resolve();
      return db.collection('users').doc(uid).update(patch).then(function () {
        profile = Object.assign({}, profile, patch);
      });
    },

    searchByFriendId: function (fid) {
      if (!enabled) return Promise.resolve(null);
      return db.collection('users').where('friendId', '==', String(fid).trim()).get().then(function (q) {
        if (q.empty) return null;
        let found = null;
        q.forEach(function (d) { found = Object.assign({ uid: d.id }, d.data()); });
        return found;
      });
    },

    sendRequest: function (fid) {
      if (!enabled) return Promise.resolve({ ok: false, msg: 'cloud-offline' });
      const me = profile || {};
      return Cloud.searchByFriendId(fid).then(function (target) {
        if (!target) return { ok: false, msg: 'not-found' };
        if (target.uid === uid) return { ok: false, msg: 'self' };
        const rid = pairKey(uid, target.uid);
        return db.collection('friendRequests').doc(rid).get().then(function (d) {
          if (d.exists) {
            const s = d.data().status;
            if (s === 'accepted') return { ok: false, msg: 'already-friend' };
            if (s === 'pending') return { ok: false, msg: 'already-sent' };
          }
          return d.ref.set({
            fromUid: uid, fromName: me.name || '收纳用户', fromFriendId: me.friendId,
            toUid: target.uid, toName: target.name || '收纳用户',
            status: 'pending', time: Date.now()
          }).then(function () {
            return { ok: true, msg: 'sent', target: target };
          });
        });
      }).catch(function (e) { return { ok: false, msg: e.message || 'error' }; });
    },

    getRequests: function () { return cache.requests.slice(); },
    getSent: function () { return cache.sent.slice(); },
    getFriends: function () { return cache.friends.slice(); },

    acceptRequest: function (req) {
      if (!enabled) return Promise.resolve();
      const me = profile || {};
      const batch = db.batch();
      batch.set(db.collection('friends').doc(uid).collection('contacts').doc(req.fromUid), {
        friendId: req.fromFriendId, name: req.fromName, time: Date.now()
      });
      batch.set(db.collection('friends').doc(req.fromUid).collection('contacts').doc(uid), {
        friendId: me.friendId, name: me.name || '收纳用户', time: Date.now()
      });
      batch.update(db.collection('friendRequests').doc(req.id), { status: 'accepted' });
      return batch.commit();
    },

    rejectRequest: function (req) {
      if (!enabled) return Promise.resolve();
      return db.collection('friendRequests').doc(req.id).update({ status: 'rejected' });
    },

    removeFriend: function (friendUid) {
      if (!enabled) return Promise.resolve();
      const key = pairKey(uid, friendUid);
      // 先清空两人聊天记录，再删好友关系与申请，保证删除好友后聊天记录同步消失
      return db.collection('chats').doc(key).collection('messages').get().then(function (snap) {
        const batch = db.batch();
        snap.forEach(function (d) { batch.delete(d.ref); });
        batch.delete(db.collection('friends').doc(uid).collection('contacts').doc(friendUid));
        batch.delete(db.collection('friends').doc(friendUid).collection('contacts').doc(uid));
        batch.delete(db.collection('friendRequests').doc(key));
        return batch.commit();
      });
    },

    chatKeyWith: function (friendUid) { return pairKey(uid, friendUid); },

    watchMessages: function (friendUid, cb) {
      const key = pairKey(uid, friendUid);
      if (unsub.messages[key]) unsub.messages[key]();
      unsub.messages[key] = db.collection('chats').doc(key).collection('messages')
        .orderBy('time', 'asc').onSnapshot(function (snap) {
          const list = [];
          snap.forEach(function (d) { list.push(Object.assign({ id: d.id }, d.data())); });
          cache.messages[key] = list;
          if (typeof cb === 'function') cb(list, key);
          notify('messages');
        });
      return key;
    },

    stopWatchingMessages: function (friendUid) {
      const key = pairKey(uid, friendUid);
      if (unsub.messages[key]) { unsub.messages[key](); delete unsub.messages[key]; }
    },

    sendMessage: function (friendUid, text, type) {
      if (!enabled) return Promise.resolve();
      const key = pairKey(uid, friendUid);
      return db.collection('chats').doc(key).collection('messages').add({
        fromUid: uid, text: text, type: type || 'text', time: Date.now()
      });
    },

    clearMessages: function (friendUid) {
      if (!enabled) return Promise.resolve();
      const key = pairKey(uid, friendUid);
      return db.collection('chats').doc(key).collection('messages').get().then(function (snap) {
        const batch = db.batch();
        snap.forEach(function (d) { batch.delete(d.ref); });
        return batch.commit();
      });
    }
  };

  global.Cloud = Cloud;
})(window);
