package com.focusisland.companion;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.HashSet;
import java.util.Set;

final class SettingsStore {
    private final SharedPreferences preferences;
    SettingsStore(Context context) {
        preferences = context.getSharedPreferences("sharing", Context.MODE_PRIVATE);
    }
    String computer() { return preferences.getString("computer", ""); }
    void computer(String address) { preferences.edit().putString("computer", address).apply(); }
    boolean nameOnly() { return preferences.getBoolean("nameOnly", true); }
    void nameOnly(boolean value) { preferences.edit().putBoolean("nameOnly", value).apply(); }
    boolean whitelist() { return preferences.getBoolean("whitelist", false); }
    void whitelist(boolean value) { preferences.edit().putBoolean("whitelist", value).apply(); }
    Set<String> packages() {
        return new HashSet<>(preferences.getStringSet("packages", new HashSet<>()));
    }
    void packages(Set<String> value) { preferences.edit().putStringSet("packages", new HashSet<>(value)).apply(); }
}
