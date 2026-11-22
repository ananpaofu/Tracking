/* 云端好友与聊天模块（Storage Organizer v1.34）
   后端：腾讯云开发 CloudBase（国内直连）
   对外接口与旧版 Firebase 版保持一致，mobile.js 无需改动。
   集合：users / friendRequests / friends / messages */
(function (global) {
  'use strict';

  // ====== 在这里填入你的云开发环境 ID ======
  const ENV_ID = 'tracking-d2gp91w5ga78956c2';
  const REGION = 'ap-shanghai';
  // =========================================

  let app = null, db = null, uid = null, profile = null;
  let enabled = false;
  const unsub = { requests: null, sent: null, friends: null, messages: {} };
  const cache = { requests: [], sent: [], friends: [], messages: {} };

  global.__cloudError = '';

  function rand6() { return String(Math.floor(100000 + Math.random() * 900000)); }
  function pairKey(a, b) { return [a, b].slice().sort().join('_'); }
  function now() { return Date.now(); }

  function notify(type) {
    if (typeof global.__cloudOnChange === 'function') {
      try { global.__cloudOnChange(type); } catch (e) { console.warn(e); }
    }
  }

  function docData(res) {
    // CloudBase get() 返回 { data: [...] } 或 { data: [...] }
    if (res && Array.isArray(res.data)) return res.data;
    if (res && Array.isArray(res.result && res.result.data)) return res.result.data;
    return [];
  }

  function readUser(friendUid) {
    return db.collection('users').doc(friendUid).get().then(function (res) {
      const arr = docData(res);
      const d = arr[0];
      return d ? Object.assign({ uid: friendUid }, d) : null;
    }).catch(function () { return null; });
  }

  function ensureProfile() {
    return db.collection('users').doc(uid).get().then(function (res) {
      const arr = docData(res);
      if (arr.length) { profile = arr[0]; return profile; }
      // 新建资料：先随机生成 6 位编号并查重
      let fid = rand6();
      const tryUnique = function (attempt) {
        return db.collection('users').where({ friendId: fid }).get().then(function (r) {
          const found = docData(r);
          if (found.length && attempt < 12) { fid = rand6(); return tryUnique(attempt + 1); }
          profile = { friendId: fid, name: '收纳用户', bio: '', avatar: '', createdAt: now() };
          return db.collection('users').doc(uid).set(profile).then(function () { return profile; });
        });
      };
      return tryUnique(0);
    });
  }

  // ====== 初始化 ======
  const ready = (function () {
    if (typeof global.cloudbase === 'undefined') {
      global.__cloudError = 'SDK_NOT_LOADED';
      return Promise.resolve(false);
    }
    if (!ENV_ID || ENV_ID.indexOf('REPLACE') === 0) {
      global.__cloudError = 'ENV_NOT_SET';
      return Promise.resolve(false);
    }
    try {
      app = global.cloudbase.init({ env: ENV_ID, region: REGION });
      db = app.database();
      const auth = app.auth;
      return auth.signInAnonymously().then(function (res) {
        if (res && res.error) throw res.error;
        const user = (res && res.data && res.data.user) || (res && res.user) || (auth.currentUser && auth.currentUser());
        uid = user && (user.uid || user.sub || user.id);
        if (!uid && auth.currentUser) {
          const cu = auth.currentUser();
          uid = cu && (cu.uid || cu.sub);
        }
        if (!uid) throw new Error('NO_UID');
        return ensureProfile();
      }).then(function () {
        enabled = true;
        startListeners();
        return true;
      }).catch(function (e) {
        global.__cloudError = (e && (e.code || e.message)) || 'INIT_FAILED';
        console.warn('[Cloud] init failed:', e);
        enabled = false;
        return false;
      });
    } catch (e) {
      global.__cloudError = (e && (e.code || e.message)) || 'SETUP_FAILED';
      console.warn('[Cloud] setup failed:', e);
      return Promise.resolve(false);
    }
  })();

  function startListeners() {
    // 收到的好友申请
    unsub.requests = db.collection('friendRequests').where({ toUid: uid }).watch({
      onChange: function (snap) {
        cache.requests = docData(snap).filter(function (r) { return r.status === 'pending'; })
          .map(function (r) { return Object.assign({ id: r._id }, r); });
        notify('requests');
      },
      onError: function (e) { console.warn('[Cloud] requests watch:', e); }
    });
    // 我发出的申请
    unsub.sent = db.collection('friendRequests').where({ fromUid: uid }).watch({
      onChange: function (snap) {
        cache.sent = docData(snap).map(function (r) { return Object.assign({ id: r._id }, r); });
        notify('sent');
      },
      onError: function (e) { console.warn('[Cloud] sent watch:', e); }
    });
    // 好友列表
    unsub.friends = db.collection('friends').where({ members: uid }).watch({
      onChange: function (snap) {
        const uids = [];
        docData(snap).forEach(function (f) {
          const m = (f.members || []).filter(function (x) { return x !== uid; });
          m.forEach(function (x) { if (uids.indexOf(x) === -1) uids.push(x); });
        });
        Promise.all(uids.map(readUser)).then(function (list) {
          cache.friends = list.filter(Boolean);
          notify('friends');
        });
      },
      onError: function (e) { console.warn('[Cloud] friends watch:', e); }
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
      return db.collection('users').where({ friendId: String(fid).trim() }).get().then(function (r) {
        const arr = docData(r);
        if (!arr.length) return null;
        const d = arr[0];
        return Object.assign({ uid: d._id || d.uid }, d);
      });
    },

    sendRequest: function (fid) {
      if (!enabled) return Promise.resolve({ ok: false, msg: 'cloud-offline' });
      const me = profile || {};
      return Cloud.searchByFriendId(fid).then(function (target) {
        if (!target) return { ok: false, msg: 'not-found' };
        if ((target.uid || target._id) === uid) return { ok: false, msg: 'self' };
        const toUid = target.uid || target._id;
        const rid = pairKey(uid, toUid);
        return db.collection('friendRequests').doc(rid).get().then(function (r) {
          const arr = docData(r);
          if (arr.length) {
            const s = arr[0].status;
            if (s === 'accepted') return { ok: false, msg: 'already-friend' };
            if (s === 'pending') return { ok: false, msg: 'already-sent' };
          }
          return db.collection('friendRequests').doc(rid).set({
            fromUid: uid, fromName: me.name || '收纳用户', fromFriendId: me.friendId,
            toUid: toUid, toName: target.name || '收纳用户',
            status: 'pending', time: now()
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
      const fromUid = req.fromUid;
      const rid = req.id || pairKey(uid, fromUid);
      const relId = pairKey(uid, fromUid);
      return db.collection('friends').doc(relId).set({
        members: [uid, fromUid],
        uidA: uid, uidB: fromUid,
        aName: me.name || '收纳用户', bName: req.fromName || '好友',
        aFriendId: me.friendId, bFriendId: req.fromFriendId,
        time: now()
      }).then(function () {
        return db.collection('friendRequests').doc(rid).update({ status: 'accepted' });
      });
    },

    rejectRequest: function (req) {
      if (!enabled) return Promise.resolve();
      return db.collection('friendRequests').doc(req.id).update({ status: 'rejected' });
    },

    removeFriend: function (friendUid) {
      if (!enabled) return Promise.resolve();
      const key = pairKey(uid, friendUid);
      // 清空两人聊天记录
      return db.collection('messages').where({ chatKey: key }).get().then(function (r) {
        const list = docData(r);
        return Promise.all(list.map(function (m) {
          return db.collection('messages').doc(m._id).remove();
        }));
      }).then(function () {
        return db.collection('friends').doc(key).remove();
      }).then(function () {
        return db.collection('friendRequests').doc(key).remove().catch(function () {});
      });
    },

    chatKeyWith: function (friendUid) { return pairKey(uid, friendUid); },

    watchMessages: function (friendUid, cb) {
      const key = pairKey(uid, friendUid);
      if (unsub.messages[key]) { try { unsub.messages[key].close(); } catch (e) {} }
      unsub.messages[key] = db.collection('messages').where({ chatKey: key }).watch({
        onChange: function (snap) {
          const list = docData(snap).slice().sort(function (a, b) { return (a.time || 0) - (b.time || 0); })
            .map(function (m) { return Object.assign({ id: m._id }, m); });
          cache.messages[key] = list;
          if (typeof cb === 'function') cb(list, key);
          notify('messages');
        },
        onError: function (e) { console.warn('[Cloud] messages watch:', e); }
      });
      return key;
    },

    stopWatchingMessages: function (friendUid) {
      const key = pairKey(uid, friendUid);
      if (unsub.messages[key]) { try { unsub.messages[key].close(); } catch (e) {} delete unsub.messages[key]; }
    },

    sendMessage: function (friendUid, text, type) {
      if (!enabled) return Promise.resolve();
      const key = pairKey(uid, friendUid);
      return db.collection('messages').add({
        chatKey: key, fromUid: uid, text: text, type: type || 'text', time: now()
      });
    },

    clearMessages: function (friendUid) {
      if (!enabled) return Promise.resolve();
      const key = pairKey(uid, friendUid);
      return db.collection('messages').where({ chatKey: key }).get().then(function (r) {
        return Promise.all(docData(r).map(function (m) {
          return db.collection('messages').doc(m._id).remove();
        }));
      });
    }
  };

  global.Cloud = Cloud;
})(window);
