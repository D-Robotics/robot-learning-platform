(() => {
  'use strict';

  // This deployment runs independent simulations. The unmodified upstream
  // bundle has a public peer room; disable its transport before any upstream
  // script can create a peer or prewarm its external STUN connections.
  const blockedPeer = Object.freeze(function RTCPeerConnection() {
    throw new DOMException('此页面使用单机仿真。', 'NotAllowedError');
  });
  try {
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
      Object.defineProperty(window, name, {
        value: blockedPeer,
        writable: false,
        configurable: false,
      });
    }
    document.documentElement.dataset.rdkSimulationNetwork = 'local';
  } catch {
    // Stop the upstream scripts if this browser cannot enforce the boundary.
    // A partial transport block must never be reported as a private scene.
    const policy = document.createElement('meta');
    policy.setAttribute('http-equiv', 'Content-Security-Policy');
    policy.setAttribute('content', "script-src 'none'; connect-src 'none'; worker-src 'none'");
    document.head.appendChild(policy);
    document.documentElement.dataset.rdkSimulationNetwork = 'blocked';
    throw new Error('无法初始化单机仿真。');
  }
})();
