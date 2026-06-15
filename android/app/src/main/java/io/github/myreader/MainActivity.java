package io.github.myreader;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.appcompat.app.AppCompatActivity;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

public class MainActivity extends AppCompatActivity {
    private WebView webView;
    private ValueCallback<Uri[]> mFilePathCallback;
    private static final int FILE_CHOOSER_REQUEST = 100;
    private static final int NATIVE_FILE_PICK = 200;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setDatabaseEnabled(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // 原生文件选择接口（更可靠，适配 MIUI 等系统）
        webView.addJavascriptInterface(new NativeBridge(), "NativeReader");

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                              FileChooserParams fileChooserParams) {
                if (mFilePathCallback != null) {
                    mFilePathCallback.onReceiveValue(null);
                }
                mFilePathCallback = filePathCallback;

                Intent intent = fileChooserParams.createIntent();
                intent.setType("*/*");
                String[] extraMimeTypes = {"application/epub+zip", "application/octet-stream"};
                intent.putExtra(Intent.EXTRA_MIME_TYPES, extraMimeTypes);

                try {
                    startActivityForResult(Intent.createChooser(intent, "选择电子书"), FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    mFilePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.loadUrl("https://posthumacutts-coder.github.io/my-reader/");
    }

    // ==== 原生文件选择桥接（解决 MIUI 等系统兼容性问题）====

    private class NativeBridge {
        @JavascriptInterface
        public void pickFile() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                String[] mimeTypes = {"application/epub+zip", "application/octet-stream", "*/*"};
                intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
                try {
                    startActivityForResult(intent, NATIVE_FILE_PICK);
                } catch (Exception e) {
                    // 如果原生选择也失败，回退到 WebView 文件选择
                    webView.evaluateJavascript("document.getElementById('fileInput').click()", null);
                }
            });
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == NATIVE_FILE_PICK) {
            // 原生文件选择回调
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                handleNativeFilePick(data.getData());
            }
            return;
        }

        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (mFilePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                Uri uri = data.getData();
                if (uri != null) {
                    results = new Uri[]{uri};
                }
            }
            mFilePathCallback.onReceiveValue(results);
            mFilePathCallback = null;
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    /** 读取选中文件并通过 JS 注入到网页 */
    private void handleNativeFilePick(Uri uri) {
        try {
            // 获取文件名
            String fileName = uri.getLastPathSegment();
            if (fileName == null) fileName = "book.epub";
            // 清理文件名
            int cut = fileName.lastIndexOf('/');
            if (cut != -1) fileName = fileName.substring(cut + 1);
            fileName = fileName.replace("'", "\\'");

            // 读取文件内容为 base64
            InputStream is = getContentResolver().openInputStream(uri);
            if (is == null) return;

            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int len;
            while ((len = is.read(buffer)) != -1) {
                baos.write(buffer, 0, len);
            }
            is.close();
            byte[] fileData = baos.toByteArray();
            String base64 = Base64.encodeToString(fileData, Base64.NO_WRAP);

            // 注入 JS：把文件数据传给网页处理
            final String js = "if(window.receiveNativeFile){" +
                "window.receiveNativeFile('" + fileName + "','" + base64 + "')" +
                "}";
            webView.post(() -> webView.evaluateJavascript(js, null));

        } catch (Exception e) {
            webView.post(() -> webView.evaluateJavascript(
                "alert('文件读取失败：'+" + e.getMessage().replace("'", "\\'") + ")", null));
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onRestoreInstanceState(Bundle savedInstanceState) {
        super.onRestoreInstanceState(savedInstanceState);
        webView.restoreState(savedInstanceState);
    }
}
