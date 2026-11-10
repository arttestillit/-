'use strict';
/*
 * Android アプリ版（Capacitor）でだけ使う機能。ブラウザで開いたときは NATIVE = null。
 *  - 画面OFF・他アプリ使用中でも位置を受け取る（通知欄に「記録中」を表示する前景サービス）
 *  - ルート外れなどの通知、振動
 *  - GPX の保存と共有
 *  - 戻るボタン
 */
const NATIVE = (() => {
  const C = window.Capacitor;
  if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform()) return null;
  const plugin = (name) => (C.registerPlugin ? C.registerPlugin(name) : C.Plugins[name]);
  const BG = plugin('BackgroundGeolocation');
  const LN = plugin('LocalNotifications');
  const FS = plugin('Filesystem');
  const SH = plugin('Share');
  const HP = plugin('Haptics');
  const APP = plugin('App');

  let watcherId = null, watcherBg = null, starting = null;
  let notifId = 1;

  return {
    // 位置の監視。background=true（記録中）なら通知を出して裏でも取り続ける
    async watch(background, onFix, onError) {
      if (starting) await starting.catch(() => {});
      if (watcherId && watcherBg === background) return;
      starting = (async () => {
        if (watcherId) { try { await BG.removeWatcher({ id: watcherId }); } catch {} watcherId = null; }
        const opts = { requestPermissions: true, stale: false, distanceFilter: 0 };
        if (background) {
          opts.backgroundTitle = '山GPS 記録中';
          opts.backgroundMessage = `${fmtInterval(settings.interval)}ごとに位置を記録しています`;
        }
        watcherId = await BG.addWatcher(opts, (loc, err) => {
          if (err) {
            if (err.code === 'NOT_AUTHORIZED') {
              if (confirm('位置情報の利用が許可されていません。設定を開いて「アプリの使用中のみ許可」を選んでください。')) BG.openSettings();
            }
            onError({ code: err.code === 'NOT_AUTHORIZED' ? 1 : 2, message: err.message });
            return;
          }
          onFix({
            coords: { latitude: loc.latitude, longitude: loc.longitude, altitude: loc.altitude, accuracy: loc.accuracy },
            timestamp: loc.time || Date.now(),
          });
        });
        watcherBg = background;
      })();
      await starting;
      starting = null;
    },
    openSettings() { return BG.openSettings(); },
    async requestNotifications() {
      try {
        const p = await LN.checkPermissions();
        if (p.display !== 'granted') await LN.requestPermissions();
      } catch {}
    },
    // 振動＋（アプリが裏にあるときは）通知
    async alert(title, body, strong = true) {
      try { await HP.vibrate({ duration: strong ? 900 : 200 }); } catch {}
      if (document.visibilityState === 'hidden') {
        try { await LN.schedule({ notifications: [{ id: notifId++, title, body }] }); } catch {}
      }
    },
    async saveAndShare(name, text) {
      try {
        const r = await FS.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
        await SH.share({ title: name, files: [r.uri], dialogTitle: 'GPXを保存・共有' });
      } catch (e) {
        if (!/cancel/i.test(String(e && e.message))) toast('保存に失敗しました: ' + (e && e.message), 5000);
      }
    },
    onBack(handler) { APP.addListener('backButton', handler); },
    minimize() { return APP.minimizeApp(); },
  };
})();
document.documentElement.classList.add(NATIVE ? 'is-native' : 'is-web');
