package com.p2pdesk.android;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AndroidHostSanityTest {
    @Test
    public void exportedConstantsAreAvailable() {
        assertTrue(HostService.EXTRA_CODE.length() > 0);
        assertTrue(HostService.EXTRA_SIGNALING.length() > 0);
    }
}
