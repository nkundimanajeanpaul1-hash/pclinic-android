package com.nkundimana.pclinic;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * VaultMirror — copies the hidden app vault (files/pclinic_vault/) into a
 * user-granted shared-storage tree (SAF, persistable permission) so the data
 * SURVIVES UNINSTALL. Folder is created as ".pclinic-vault" (hidden).
 */
@CapacitorPlugin(name = "VaultMirror")
public class VaultMirrorPlugin extends Plugin {

    private static final String PREFS = "pclinic_vault_mirror";
    private static final String KEY_URI = "tree_uri";
    private static final String KEY_LAST = "last_mirror";
    private static final String DIR_NAME = ".pclinic-vault";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
    }

    // SAF queries and file copies block; Capacitor hands plugin calls to us on the
    // UI thread, so long vaults would jank or ANR the app.
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @PluginMethod()
    public void grantTree(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "treeResult");
    }

    @ActivityCallback
    private void treeResult(PluginCall call, ActivityResult result) {
        JSObject ret = new JSObject();
        if (call == null) return;
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null
                && result.getData().getData() != null) {
            Uri uri = result.getData().getData();
            try {
                getContext().getContentResolver().takePersistableUriPermission(uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) { }
            prefs().edit().putString(KEY_URI, uri.toString()).apply();
            ret.put("granted", true);
        } else {
            ret.put("granted", false);
        }
        call.resolve(ret);
    }

    @PluginMethod()
    public void mirror(PluginCall call) {
        io.execute(() -> doMirror(call));
    }

    private void doMirror(PluginCall call) {
        try {
            String uriStr = prefs().getString(KEY_URI, null);
            if (uriStr == null) { call.reject("no tree granted"); return; }
            Uri tree = Uri.parse(uriStr);
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), tree);
            if (root == null) { call.reject("tree unavailable"); return; }
            DocumentFile dir = root.findFile(DIR_NAME);
            if (dir == null) dir = root.createDirectory(DIR_NAME);
            if (dir == null) { call.reject("cannot create mirror dir"); return; }

            File vault = new File(getContext().getFilesDir(), "pclinic_vault");
            int copied = 0;
            copied += copyInto(dir, new File(vault, "records.enc"), "records.enc") ? 1 : 0;
            copied += copyInto(dir, new File(vault, "manifest.json"), "manifest.json") ? 1 : 0;

            DocumentFile info = dir.findFile("mirror-info.json");
            if (info == null) info = dir.createFile("application/json", "mirror-info.json");
            if (info != null) {
                JSONObject j = new JSONObject();
                j.put("device", android.os.Build.MODEL);
                j.put("mirroredAt", System.currentTimeMillis());
                j.put("package", getContext().getPackageName());
                writeBytes(info, j.toString().getBytes("UTF-8"));
            }
            long now = System.currentTimeMillis();
            prefs().edit().putLong(KEY_LAST, now).apply();

            com.getcapacitor.JSObject ret = new com.getcapacitor.JSObject();
            ret.put("ok", true);
            ret.put("copied", copied);
            ret.put("at", now);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("mirror failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod()
    public void restore(PluginCall call) {
        io.execute(() -> doRestore(call));
    }

    private void doRestore(PluginCall call) {
        try {
            String uriStr = prefs().getString(KEY_URI, null);
            if (uriStr == null) { call.reject("no tree granted"); return; }
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(uriStr));
            if (root == null) { call.reject("tree unavailable"); return; }
            DocumentFile dir = root.findFile(DIR_NAME);
            if (dir == null) {
                com.getcapacitor.JSObject r = new com.getcapacitor.JSObject();
                r.put("ok", false);
                call.resolve(r);
                return;
            }
            File vault = new File(getContext().getFilesDir(), "pclinic_vault");
            if (!vault.exists() && !vault.mkdirs()) { call.reject("cannot create vault"); return; }
            boolean rec = readFrom(dir, "records.enc", new File(vault, "records.enc"));
            readFrom(dir, "manifest.json", new File(vault, "manifest.json"));
            int count = -1;
            File man = new File(vault, "manifest.json");
            if (man.exists()) {
                String s = new String(readAll(new FileInputStream(man)), "UTF-8");
                try { count = new JSONObject(s).optInt("count", -1); } catch (Exception ignored) {}
            }
            com.getcapacitor.JSObject ret = new com.getcapacitor.JSObject();
            ret.put("ok", rec);
            ret.put("count", count);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("restore failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod()
    public void status(PluginCall call) {
        com.getcapacitor.JSObject ret = new com.getcapacitor.JSObject();
        ret.put("granted", prefs().getString(KEY_URI, null) != null);
        ret.put("lastMirror", prefs().getLong(KEY_LAST, 0L));
        call.resolve(ret);
    }

    /* ── helpers ── */

    private boolean copyInto(DocumentFile dir, File src, String name) throws Exception {
        if (!src.exists()) return false;
        DocumentFile dst = dir.findFile(name);
        if (dst != null) dst.delete();
        dst = dir.createFile("application/octet-stream", name);
        if (dst == null) return false;
        writeBytes(dst, readAll(new FileInputStream(src)));
        return true;
    }

    private boolean readFrom(DocumentFile dir, String name, File dst) throws Exception {
        DocumentFile src = dir.findFile(name);
        if (src == null) return false;
        InputStream in = getContext().getContentResolver().openInputStream(src.getUri());
        if (in == null) return false;
        byte[] data = readAll(in);
        OutputStream out = new java.io.FileOutputStream(dst);
        out.write(data);
        out.close();
        return true;
    }

    private void writeBytes(DocumentFile dst, byte[] data) throws Exception {
        OutputStream out = getContext().getContentResolver().openOutputStream(dst.getUri(), "wt");
        if (out == null) return;
        out.write(data);
        out.flush();
        out.close();
    }

    private byte[] readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return bos.toByteArray();
    }
}
