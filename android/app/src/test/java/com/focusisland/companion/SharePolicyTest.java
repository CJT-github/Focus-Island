package com.focusisland.companion;

import org.junit.Test;
import java.util.Set;
import static org.junit.Assert.*;

public class SharePolicyTest {
    @Test public void onlySelectedAndBondedComputerIsAuthorized() {
        assertTrue(SharePolicy.authorized("AA:BB:CC:DD:EE:FF", "aa:bb:cc:dd:ee:ff", true));
        assertFalse(SharePolicy.authorized("AA", "BB", true));
        assertFalse(SharePolicy.authorized("AA", "AA", false));
        assertFalse(SharePolicy.authorized("", "", true));
        assertFalse(SharePolicy.authorized(null, "AA", true));
    }

    @Test public void ignoresOwnOngoingAndGroupSummaries() {
        Set<String> empty = Set.of();
        assertTrue(SharePolicy.allows("self", "chat", false, false, false, empty));
        assertFalse(SharePolicy.allows("self", "self", false, false, false, empty));
        assertFalse(SharePolicy.allows("self", "chat", true, false, false, empty));
        assertFalse(SharePolicy.allows("self", "chat", false, true, false, empty));
    }

    @Test public void emptyWhitelistSharesNothingAndSelectedAppsOnly() {
        assertFalse(SharePolicy.allows("self", "chat", false, false, true, Set.of()));
        assertTrue(SharePolicy.allows("self", "chat", false, false, true, Set.of("chat")));
        assertFalse(SharePolicy.allows("self", "bank", false, false, true, Set.of("chat")));
    }
}
