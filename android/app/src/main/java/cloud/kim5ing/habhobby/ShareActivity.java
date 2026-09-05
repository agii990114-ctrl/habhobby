package cloud.kim5ing.habhobby;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;

import org.json.JSONObject;

/** 다른 앱에서 「공유」로 넘어온 주소를 담는다.
 *
 *  <p><b>보이는 창을 띄우지 않는다.</b> 웹앱(PWA)의 공유 대상은 규격상 반드시 앱이 떠야
 *  해서, 누르면 화면이 한 번 번쩍였다. 이 앱을 만든 까닭이 그것 하나다.
 *
 *  <p><b>쿠키를 쓸 수 없다.</b> 이 요청은 크롬 밖에서 나가므로 웹에서 한 로그인이 따라오지
 *  않는다(그건 TWA 로 띄운 화면에서만 그렇다). 그래서 공유 열쇠를 머리글에 얹는다.
 *
 *  <p><b>답을 받을 때까지 살아 있는다.</b> 처음에는 창을 아예 안 만들고(windowNoDisplay)
 *  화면에서 사라지면 끝나게(noHistory) 두었는데, 그 둘은 「곧바로 끝나는 액티비티」를 위한
 *  것이라 서버를 기다리는 동안 시스템이 이쪽을 끝내 버렸다 — 요청이 나가다 말았다. */
public class ShareActivity extends Activity {

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);

    final String text = sharedText(getIntent());
    if (text.isEmpty()) { done("보낼 주소가 없습니다", null); return; }

    final String key = Keys.get(this);
    if (key.isEmpty()) {
      /* 열쇠가 없으면 넣는 화면으로 보낸다. 여기서 조용히 실패하면 「공유가 안 되네」로만
         보이고, 무엇을 해야 하는지 알 길이 없다. */
      Toast.makeText(this, "먼저 공유 열쇠를 넣어 주세요", Toast.LENGTH_LONG).show();
      startActivity(new Intent(this, SetupActivity.class));
      finish();
      return;
    }

    new Thread(() -> {
      Api.Result r = Api.share(getString(R.string.share_endpoint), key, text);
      String msg, open = null;
      boolean setup = false;

      if (!r.reached()) {
        msg = "서버에 닿지 못했습니다 — " + r.error;
      } else if (r.code == 401) {
        /* **틀린 열쇠는 고칠 자리로 데려간다.** 넣는 화면은 열쇠가 비었을 때만 열리도록
           두었더니, 한 번 잘못 넣고 나면 다시 들어갈 길이 없었다 — 토스트만 뜨고 끝이다. */
        msg = "공유 열쇠가 맞지 않습니다";
        setup = true;
      } else if (r.code >= 400) {
        msg = "담지 못했습니다 (" + r.code + ")";
      } else {
        /* **일어난 일의 이름은 서버가 짓는다**(text). 여기서 saved·made 를 보고 문장을
           지으면 같은 말이 두 곳에 살고, 한쪽만 고치게 된다. 이쪽이 짓는 것은 서버가 알 수
           없는 것들뿐이다 — 못 닿았다, 열쇠가 틀렸다. */
        JSONObject j = json(r.body);
        msg = j == null ? "답을 읽지 못했습니다" : j.optString("text", "담았습니다");
        if (j != null && !j.optBoolean("saved")) open = j.optString("open", "");
      }

      final String m = msg, o = open;
      final boolean fix = setup;
      runOnUiThread(() -> {
        if (fix) startActivity(new Intent(this, SetupActivity.class));
        done(m, o);
      });
    }).start();
  }

  /** 「제목 https://…」처럼 글이 섞여 와도 그대로 보낸다 — 주소만 골라내는 일은 서버가 한다. */
  private static String sharedText(Intent it) {
    if (it == null || !Intent.ACTION_SEND.equals(it.getAction())) return "";
    String s = it.getStringExtra(Intent.EXTRA_TEXT);
    if (s == null) s = it.getStringExtra(Intent.EXTRA_SUBJECT);
    return s == null ? "" : s.trim();
  }

  static JSONObject json(String s) {
    try { return new JSONObject(s); } catch (Exception e) { return null; }
  }

  private void done(String msg, String open) {
    Toast.makeText(getApplicationContext(), msg, Toast.LENGTH_LONG).show();
    if (open != null && !open.isEmpty()) {
      Intent go = new Intent(Intent.ACTION_VIEW, Uri.parse(open));
      go.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      try { startActivity(go); } catch (Exception ignored) { /* 열 데가 없으면 토스트로 끝 */ }
    }
    finish();
  }
}
