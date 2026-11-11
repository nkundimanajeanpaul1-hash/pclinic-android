# Add project specific ProGuard rules here.
#
# R8 is now enabled for release builds (minifyEnabled true). These rules keep
# everything Capacitor and its plugins look up by reflection / annotation.

# ---- Capacitor core -----------------------------------------------------------
-keep class com.getcapacitor.** { *; }
-keep class org.apache.cordova.** { *; }
-keep public class * extends com.getcapacitor.Plugin
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod <methods>;
}
-keep class com.capacitorjs.plugins.** { *; }

# ---- App ----------------------------------------------------------------------
-keep class com.nkundimana.pclinic.** { *; }

# ---- Web <-> native bridge ----------------------------------------------------
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Useful stack traces from a release build
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
