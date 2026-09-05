package cloud.kim5ing.habhobby;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/** 열쇠를 붙여 넣는 화면.
 *
 *  <p><b>저장하면서 곧바로 물어본다.</b> 열쇠가 맞는지는 공유해 봐야 알 수 있었는데, 그때는
 *  화면이 없어서 토스트 한 줄이 전부다 — 틀린 줄 모르고 「공유가 안 되네」로 끝난다.
 *  빈 주소로 한 번 보내 보면 서버가 담지 않고 답만 주므로, 그것으로 여기서 가릴 수 있다.
 *
 *  <p>화면 하나에 칸 하나뿐이라 레이아웃 xml 을 따로 두지 않았다 — 파일을 오갈수록
 *  「어디에 뭐가 있나」만 늘어난다. 여기서 다 보인다. */
public class SetupActivity extends Activity {

  private TextView state;

  @Override
  protected void onCreate(Bundle saved) {
    super.onCreate(saved);

    int pad = dp(20);
    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    box.setPadding(pad, pad, pad, pad);
    box.setGravity(Gravity.CENTER_VERTICAL);

    final EditText input = new EditText(this);
    input.setHint(R.string.setup_hint);
    input.setSingleLine(true);
    // 자동 대문자·자동 고침이 열쇠를 조용히 망가뜨린다 — 붙여 넣은 그대로여야 한다.
    input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    input.setText(Keys.get(this));

    TextView help = new TextView(this);
    help.setText(R.string.setup_help);
    help.setPadding(0, dp(12), 0, dp(16));

    final Button save = new Button(this);
    save.setText(R.string.setup_save);

    state = new TextView(this);
    state.setPadding(0, dp(16), 0, 0);

    save.setOnClickListener(v -> {
      final String key = input.getText().toString().trim();
      Keys.set(this, key);
      if (key.isEmpty()) { say("열쇠를 지웠습니다"); return; }

      save.setEnabled(false);
      say("서버에 물어보는 중…");
      new Thread(() -> {
        // 빈 주소 — 담지 않고 「열쇠가 통하는지」만 답한다
        Api.Result r = Api.share(getString(R.string.share_endpoint), key, "");
        final String msg =
            !r.reached() ? "서버에 닿지 못했습니다 — " + r.error
            : r.code == 401 ? "이 열쇠는 통하지 않습니다. 다시 복사해 보세요."
            : r.code >= 400 ? "서버가 거절했습니다 (" + r.code + ")"
            : "열쇠가 통합니다. 이제 공유로 담을 수 있습니다.";
        runOnUiThread(() -> { save.setEnabled(true); say(msg); });
      }).start();
    });

    box.addView(input);
    box.addView(help);
    box.addView(save);
    box.addView(state);
    setContentView(box);
  }

  /** 화면에도 적고 토스트로도 낸다 — 이 창을 닫고 나서도 결과가 기억에 남아야 한다. */
  private void say(String msg) {
    state.setText(msg);
    Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
  }

  private int dp(int v) {
    return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
  }
}
