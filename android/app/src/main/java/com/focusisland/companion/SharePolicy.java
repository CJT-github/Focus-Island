package com.focusisland.companion;

import java.util.Set;

final class SharePolicy {
    private SharePolicy() {}

    static boolean authorized(String selected, String address, boolean bonded) {
        return bonded && selected != null && !selected.isEmpty()
                && selected.equalsIgnoreCase(address);
    }

    static boolean allows(String ownPackage, String pkg, boolean ongoing, boolean summary,
                          boolean whitelist, Set<String> packages) {
        return pkg != null && !pkg.isEmpty() && !pkg.equals(ownPackage) && !ongoing && !summary
                && (!whitelist || packages.contains(pkg));
    }
}
