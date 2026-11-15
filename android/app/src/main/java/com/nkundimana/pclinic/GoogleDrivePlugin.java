package com.nkundimana.pclinic;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.common.api.Scope;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * GoogleDrive — SILENT backup sync to the Drive *appDataFolder* (hidden from
 * the user's Drive UI, per-app, quota-free). Scope: drive.appdata only.
 *
 * Requires an OAuth 2.0 Android client in Google Cloud Console matching this
 * package + signing SHA-1 (see GOOGLE-OAUTH-SETUP.md). No client-id string is
 * needed in code: GoogleAuthUtil resolves the client by package + certificate.
 */
@CapacitorPlugin(name = "GoogleDrive")
public class GoogleDrivePlugin extends Plugin {

    private static final String SCOPE_APPDATA = "https://www.googleapis.com/auth/drive.appdata";
    // drive.file lets the app manage files IT creates — including photos/videos
    // in a visible "PClinic Media" folder (appdata stays for vault snapshots).
    private static final String SCOPE_FILE = "https://www.googleapis.com/auth/drive.file";
    private static final String SCOPES = SCOPE_APPDATA + " " + SCOPE_FILE;
    private static final String MEDIA_FOLDER = "PClinic Media";
    private static final String PREFS = "pclinic_drive_sync";
    private static final String KEY_LAST = "last_sync";
    private static final String KEY_REC_ID = "file_id_records";
    private static final String KEY_MAN_ID = "file_id_manifest";
    private static final String KEY_HAS_SNAP = "has_snapshot";
    private static final String NAME_REC = "pclinic-vault-snapshot.enc";
    private static final String NAME_MAN = "pclinic-vault-manifest.json";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
    }

    // Capacitor invokes plugin methods on the UI thread, where any socket throws
    // NetworkOnMainThreadException. All Drive traffic belongs here instead;
    // call.resolve()/reject() are marshalled back to the main thread by the bridge.
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private static String reason(Exception e) {
        String m = e.getMessage();
        return e.getClass().getSimpleName() + (m != null && !m.isEmpty() ? ": " + m : "");
    }

    private GoogleSignInClient client() {
        GoogleSignInOptions o = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                .requestScopes(new Scope(SCOPE_APPDATA), new Scope(SCOPE_FILE))
                .requestEmail()
                .build();
        return GoogleSignIn.getClient(getActivity(), o);
    }

    @PluginMethod()
    public void signIn(PluginCall call) {
        startActivityForResult(call, client().getSignInIntent(), "signResult");
    }

    @ActivityCallback
    private void signResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("signedIn", false);
            call.resolve(cancelled);
            return;
        }
        final Intent data = result.getData();
        io.execute(() -> {
            JSObject ret = new JSObject();
            try {
                GoogleSignInAccount acc = GoogleSignIn.getSignedInAccountFromIntent(data).getResult();
                // warm the scoped token now so later silent uploads need no UI
                String token = GoogleAuthUtil.getToken(getContext(), acc.getAccount(), "oauth2:" + SCOPES);
                prefs().edit().putBoolean(KEY_HAS_SNAP, listSnapshotIds(token) != null).apply();
                ret.put("signedIn", true);
            } catch (Exception e) {
                ret.put("signedIn", false);
                ret.put("error", reason(e));
            }
            call.resolve(ret);
        });
    }

    @PluginMethod()
    public void signOut(PluginCall call) {
        client().signOut();
        prefs().edit().remove(KEY_REC_ID).remove(KEY_MAN_ID).remove(KEY_HAS_SNAP).apply();
        call.resolve(new JSObject());
    }

    @PluginMethod()
    public void status(PluginCall call) {
        io.execute(() -> {
            GoogleSignInAccount acc = GoogleSignIn.getLastSignedInAccount(getContext());
            JSObject ret = new JSObject();
            boolean signedIn = acc != null;
            boolean hasSnap = prefs().getBoolean(KEY_HAS_SNAP, false);
            if (signedIn && !hasSnap) {
                // Fresh install wipes prefs — ask Drive once so the restore nudge can fire.
                try {
                    String token = GoogleAuthUtil.getToken(getContext(), acc.getAccount(), "oauth2:" + SCOPES);
                    String[] ids = listSnapshotIds(token);
                    hasSnap = ids != null && ids[0] != null;
                    if (hasSnap) {
                        SharedPreferences.Editor ed = prefs().edit().putBoolean(KEY_HAS_SNAP, true);
                        if (ids[0] != null) ed.putString(KEY_REC_ID, ids[0]);
                        if (ids[1] != null) ed.putString(KEY_MAN_ID, ids[1]);
                        ed.apply();
                    }
                } catch (Exception ignored) { }
            }
            ret.put("signedIn", signedIn);
            ret.put("lastSync", prefs().getLong(KEY_LAST, 0L));
            ret.put("hasSnapshot", hasSnap);
            call.resolve(ret);
        });
    }

    /** Upload (or update) records.enc + manifest.json into appDataFolder. */
    @PluginMethod()
    public void uploadSnapshot(PluginCall call) {
        io.execute(() -> {
            try {
                GoogleSignInAccount acc = GoogleSignIn.getLastSignedInAccount(getContext());
                if (acc == null) {
                    JSObject ret = new JSObject();
                    ret.put("ok", false);
                    call.resolve(ret);
                    return;
                }
                String token = GoogleAuthUtil.getToken(getContext(), acc.getAccount(), "oauth2:" + SCOPES);
                try {
                    doUpload(token);
                } catch (Exception first) {
                    // Cached access tokens expire (~1h): invalidate, refetch, retry once.
                    GoogleAuthUtil.invalidateToken(getContext(), token);
                    token = GoogleAuthUtil.getToken(getContext(), acc.getAccount(), "oauth2:" + SCOPES);
                    doUpload(token);
                }
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("upload failed: " + reason(e), e);
            }
        });
    }

    private void doUpload(String token) throws Exception {
        File vault = new File(getContext().getFilesDir(), "pclinic_vault");
        File rec = new File(vault, "records.enc");
        File man = new File(vault, "manifest.json");
        if (!rec.exists()) throw new Exception("vault empty");

        String recId = prefs().getString(KEY_REC_ID, null);
        if (recId == null) recId = findByName(token, NAME_REC);
        recId = upsert(token, recId, NAME_REC, "application/octet-stream", readAll(new FileInputStream(rec)));

        String manId = prefs().getString(KEY_MAN_ID, null);
        if (man.exists()) {
            if (manId == null) manId = findByName(token, NAME_MAN);
            manId = upsert(token, manId, NAME_MAN, "application/json", readAll(new FileInputStream(man)));
        }
        prefs().edit()
                .putString(KEY_REC_ID, recId)
                .putString(KEY_MAN_ID, manId)
                .putLong(KEY_LAST, System.currentTimeMillis())
                .putBoolean(KEY_HAS_SNAP, true)
                .apply();
    }

    /** PATCH the known file id; if it vanished (404/403), create a fresh one. */
    private String upsert(String token, String id, String name, String mime, byte[] data) throws Exception {
        if (id != null) {
            try {
                mediaUpdate(token, id, data);
                return id;
            } catch (Exception ignored) {
                // stale id — fall through and create
            }
        }
        return createMultipart(token, name, mime, data);
    }

    /** Download the snapshot back into the vault (post-reinstall restore). */
    @PluginMethod()
    public void downloadSnapshot(PluginCall call) {
        io.execute(() -> {
            JSObject ret = new JSObject();
            try {
                GoogleSignInAccount acc = GoogleSignIn.getLastSignedInAccount(getContext());
                if (acc == null) { ret.put("ok", false); call.resolve(ret); return; }
                String token = GoogleAuthUtil.getToken(getContext(), acc.getAccount(), "oauth2:" + SCOPES);
                try {
                    doDownload(token, ret);
                } catch (Exception first) {
                    GoogleAuthUtil.invalidateToken(getContext(), token);
                    token = GoogleAuthUtil.getToken(getContext(), acc.getAccount(), "oauth2:" + SCOPES);
                    doDownload(token, ret);
                }
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("download failed: " + reason(e), e);
            }
        });
    }

    private void doDownload(String token, JSObject ret) throws Exception {
        String recId = prefs().getString(KEY_REC_ID, null);
        if (recId == null) recId = findByName(token, NAME_REC);
        if (recId == null) { ret.put("ok", false); return; }

        File vault = new File(getContext().getFilesDir(), "pclinic_vault");
        if (!vault.exists() && !vault.mkdirs()) throw new Exception("no vault dir");
        download(token, recId, new File(vault, "records.enc"));
        String manId = prefs().getString(KEY_MAN_ID, null);
        if (manId == null) manId = findByName(token, NAME_MAN);
        if (manId != null) download(token, manId, new File(vault, "manifest.json"));
        prefs().edit().putString(KEY_REC_ID, recId).putString(KEY_MAN_ID, manId).apply();
        ret.put("ok", true);
    }

    /* ── Drive REST helpers (appDataFolder space) ── */

    private String[] listSnapshotIds(String token) {
        try {
            JSONObject j = get(token, "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name)");
            JSONArray files = j.optJSONArray("files");
            if (files == null) return null;
            String rec = null, man = null;
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                if (NAME_REC.equals(f.optString("name"))) rec = f.optString("id");
                if (NAME_MAN.equals(f.optString("name"))) man = f.optString("id");
            }
            return new String[]{rec, man};
        } catch (Exception e) {
            return null;
        }
    }

    private String findByName(String token, String name) throws Exception {
        JSONObject j = get(token, "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder"
                + "&q=name%20%3D%20%27" + name + "%27&fields=files(id)");
        JSONArray files = j.optJSONArray("files");
        if (files != null && files.length() > 0) return files.getJSONObject(0).optString("id");
        return null;
    }

    private String createMultipart(String token, String name, String mime, byte[] data) throws Exception {
        String boundary = "pclinic" + System.currentTimeMillis();
        String meta = "{\"name\":\"" + name + "\",\"parents\":[\"appDataFolder\"]}";
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        String head = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta
                + "\r\n--" + boundary + "\r\nContent-Type: " + mime + "\r\n\r\n";
        bos.write(head.getBytes("UTF-8"));
        bos.write(data);
        bos.write(("\r\n--" + boundary + "--\r\n").getBytes("UTF-8"));
        HttpURLConnection c = (HttpURLConnection) new URL(
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart").openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Content-Type", "multipart/related; boundary=" + boundary);
        OutputStream out = c.getOutputStream();
        out.write(bos.toByteArray());
        out.close();
        int code = c.getResponseCode();
        String body = slurp(code >= 400 ? c.getErrorStream() : c.getInputStream());
        if (code >= 400) throw new Exception("drive create " + code + ": " + body);
        return new JSONObject(body).optString("id");
    }

    private void mediaUpdate(String token, String id, byte[] data) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(
                "https://www.googleapis.com/upload/drive/v3/files/" + id + "?uploadType=media").openConnection();
        c.setRequestMethod("PATCH");
        c.setDoOutput(true);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Content-Type", "application/octet-stream");
        OutputStream out = c.getOutputStream();
        out.write(data);
        out.close();
        int code = c.getResponseCode();
        if (code >= 400) throw new Exception("drive update " + code + ": " + slurp(c.getErrorStream()));
    }

    private void download(String token, String id, File dst) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(
                "https://www.googleapis.com/drive/v3/files/" + id + "?alt=media").openConnection();
        c.setRequestProperty("Authorization", "Bearer " + token);
        int code = c.getResponseCode();
        if (code >= 400) throw new Exception("drive get " + code);
        byte[] data = readAll(c.getInputStream());
        OutputStream out = new java.io.FileOutputStream(dst);
        out.write(data);
        out.close();
    }

    private JSONObject get(String token, String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestProperty("Authorization", "Bearer " + token);
        int code = c.getResponseCode();
        String body = slurp(code >= 400 ? c.getErrorStream() : c.getInputStream());
        if (code >= 400) throw new Exception("drive list " + code + ": " + body);
        return new JSONObject(body);
    }

    private String slurp(InputStream in) throws Exception {
        if (in == null) return "";
        return new String(readAll(in), "UTF-8");
    }

    private byte[] readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return bos.toByteArray();
    }

    /* ── Media sync: photos/videos in a VISIBLE "PClinic Media" folder ──
       The user asked for media to live in their Google Drive where they can
       see it. drive.file scope covers files this app creates. Each upload
       returns a file id the app stores on the media record, so a new device
       can download the bytes back on demand. */

    /** Upload one media file into the visible "PClinic Media" folder. */
    @PluginMethod()
    public void uploadMedia(PluginCall call) {
        io.execute(() -> {
            try {
                GoogleSignInAccount acc = GoogleSignIn.getLastSignedInAccount(getContext());
                if (acc == null) { call.reject("not signed in to Google Drive"); return; }
                String name = call.getString("name", "media");
                String mime = call.getString("mimeType", "application/octet-stream");
                String b64 = call.getString("dataBase64", "");
                String existingId = call.getString("fileId", null);
                byte[] data = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                String token = GoogleAuthUtil.getToken(getContext(), acc.getAccount(), "oauth2:" + SCOPES);
                String fileId;
                try {
                    fileId = doUploadMedia(token, existingId, name, mime, data);
                } catch (Exception first) {
                    GoogleAuthUtil.invalidateToken(getContext(), token);
                    token = GoogleAuthUtil.getToken(getContext(), acc.getAccount(), "oauth2:" + SCOPES);
                    fileId = doUploadMedia(token, existingId, name, mime, data);
                }
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("fileId", fileId);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("media upload failed: " + reason(e), e);
            }
        });
    }

    private String doUploadMedia(String token, String existingId, String name, String mime, byte[] data) throws Exception {
        if (existingId != null && !existingId.isEmpty()) {
            try {
                mediaUpdate(token, existingId, data);
                return existingId;
            } catch (Exception ignored) { /* stale id — create fresh below */ }
        }
        String folderId = ensureMediaFolder(token);
        return createMultipartInFolder(token, folderId, name, mime, data);
    }

    /** List the media files in the visible folder: [{id, name, mimeType}]. */
    @PluginMethod()
    public void listMedia(PluginCall call) {
        io.execute(() -> {
            try {
                GoogleSignInAccount acc = GoogleSignIn.getLastSignedInAccount(getContext());
                if (acc == null) { call.reject("not signed in to Google Drive"); return; }
                String token = GoogleAuthUtil.getToken(getContext(), acc.getAccount(), "oauth2:" + SCOPES);
                JSONArray out = new JSONArray();
                String folderId = findFolder(token, MEDIA_FOLDER);
                if (folderId != null) {
                    JSONObject j = get(token, "https://www.googleapis.com/drive/v3/files?q="
                            + java.net.URLEncoder.encode("'" + folderId + "' in parents and trashed=false", "UTF-8")
                            + "&fields=files(id,name,mimeType)&pageSize=1000");
                    JSONArray files = j.optJSONArray("files");
                    if (files != null) {
                        for (int i = 0; i < files.length(); i++) {
                            JSONObject f = files.getJSONObject(i);
                            JSONObject row = new JSONObject();
                            row.put("id", f.optString("id"));
                            row.put("name", f.optString("name"));
                            row.put("mimeType", f.optString("mimeType"));
                            out.put(row);
                        }
                    }
                }
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("files", out);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("media list failed: " + reason(e), e);
            }
        });
    }

    /** Download one media file's bytes (base64) by Drive file id. */
    @PluginMethod()
    public void downloadMedia(PluginCall call) {
        io.execute(() -> {
            try {
                GoogleSignInAccount acc = GoogleSignIn.getLastSignedInAccount(getContext());
                if (acc == null) { call.reject("not signed in to Google Drive"); return; }
                String fileId = call.getString("fileId", "");
                if (fileId == null || fileId.isEmpty()) { call.reject("no fileId"); return; }
                String token = GoogleAuthUtil.getToken(getContext(), acc.getAccount(), "oauth2:" + SCOPES);
                HttpURLConnection c = (HttpURLConnection) new URL(
                        "https://www.googleapis.com/drive/v3/files/" + fileId + "?alt=media").openConnection();
                c.setRequestProperty("Authorization", "Bearer " + token);
                int code = c.getResponseCode();
                if (code >= 400) throw new Exception("drive get " + code);
                byte[] data = readAll(c.getInputStream());
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("dataBase64", android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("media download failed: " + reason(e), e);
            }
        });
    }

    /** Find the visible media folder by name, or null. */
    private String findFolder(String token, String name) throws Exception {
        JSONObject j = get(token, "https://www.googleapis.com/drive/v3/files?q="
                + java.net.URLEncoder.encode("name='" + name + "' and mimeType='application/vnd.google-apps.folder' and trashed=false", "UTF-8")
                + "&fields=files(id)");
        JSONArray files = j.optJSONArray("files");
        if (files != null && files.length() > 0) return files.getJSONObject(0).optString("id");
        return null;
    }

    /** Find or create the visible media folder; returns its id. */
    private String ensureMediaFolder(String token) throws Exception {
        String id = findFolder(token, MEDIA_FOLDER);
        if (id != null) return id;
        String meta = "{\"name\":\"" + MEDIA_FOLDER + "\",\"mimeType\":\"application/vnd.google-apps.folder\"}";
        HttpURLConnection c = (HttpURLConnection) new URL(
                "https://www.googleapis.com/drive/v3/files?fields=id").openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        OutputStream out = c.getOutputStream();
        out.write(meta.getBytes("UTF-8"));
        out.close();
        int code = c.getResponseCode();
        String body = slurp(code >= 400 ? c.getErrorStream() : c.getInputStream());
        if (code >= 400) throw new Exception("drive folder create " + code + ": " + body);
        return new JSONObject(body).optString("id");
    }

    /** Multipart create with an explicit parent folder (visible Drive). */
    private String createMultipartInFolder(String token, String parentId, String name, String mime, byte[] data) throws Exception {
        String boundary = "pclinic" + System.currentTimeMillis();
        String safeName = name.replace("\\", "\\\\").replace("\"", "\\\"");
        String meta = "{\"name\":\"" + safeName + "\",\"parents\":[\"" + parentId + "\"]}";
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        String head = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta
                + "\r\n--" + boundary + "\r\nContent-Type: " + mime + "\r\n\r\n";
        bos.write(head.getBytes("UTF-8"));
        bos.write(data);
        bos.write(("\r\n--" + boundary + "--\r\n").getBytes("UTF-8"));
        HttpURLConnection c = (HttpURLConnection) new URL(
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart").openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Content-Type", "multipart/related; boundary=" + boundary);
        OutputStream out = c.getOutputStream();
        out.write(bos.toByteArray());
        out.close();
        int code = c.getResponseCode();
        String body = slurp(code >= 400 ? c.getErrorStream() : c.getInputStream());
        if (code >= 400) throw new Exception("drive media create " + code + ": " + body);
        return new JSONObject(body).optString("id");
    }
}
