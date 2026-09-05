package cloud.kim5ing.habhobby;

import android.content.Context;
import android.content.SharedPreferences;

/** 공유 열쇠를 두는 곳.
 *
 *  <p><b>앱 안에 구워 넣지 않는다.</b> 구워 넣으면 열쇠를 바꿀 때마다 다시 빌드해야 하고,
 *  무엇보다 그 열쇠가 소스나 apk 에 글자 그대로 남는다. 기기에 넣어 두면 이 기기 밖으로
 *  나갈 일이 없다 — 안드로이드가 앱마다 제 저장소를 갈라 준다.
 *
 *  <p>백업도 끈다(allowBackup=false). 클라우드로 따라다닐 물건이 아니다. */
final class Keys {
  private static final String FILE = "habhobby";
  private static final String KEY = "shareKey";

  private Keys() {}

  static String get(Context c) {
    return prefs(c).getString(KEY, "").trim();
  }

  static void set(Context c, String v) {
    prefs(c).edit().putString(KEY, v == null ? "" : v.trim()).apply();
  }

  private static SharedPreferences prefs(Context c) {
    return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
  }
}
