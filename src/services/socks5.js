'use strict';

const net = require('net');

/**
 * Minimal SOCKS5 CONNECT client (no external dependencies).
 *
 * Only the parts needed to establish a TCP CONNECT tunnel are implemented:
 *   - greeting with NO-AUTH method
 *   - CONNECT request (IPv4 / IPv6 / domain-name addresses)
 *   - reply parsing
 *
 * Returns a connected `net.Socket` that is already tunneled to
 * `targetHost:targetPort`. Callers are responsible for the transport on top
 * of it (e.g. `tls.connect({ socket })` for HTTPS).
 *
 * @param {string} proxyHost
 * @param {number} proxyPort
 * @param {string} targetHost
 * @param {number} targetPort
 * @param {object} [options]
 * @param {number} [options.timeout=15000] handshake timeout in ms
 * @returns {Promise<net.Socket>}
 */
function socks5Connect(proxyHost, proxyPort, targetHost, targetPort, options = {}) {
  const timeoutMs = options.timeout || 15000;

  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });

    let settled = false;
    const timer = setTimeout(() => fail(new Error('SOCKS5 handshake timed out')), timeoutMs);

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    }

    function succeed() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.setTimeout(0);
      socket.removeAllListeners('data');
      resolve(socket);
    }

    socket.once('error', (err) => fail(err));

    // Build the CONNECT request payload.
    const family = net.isIP(targetHost);
    let atyp;
    let address;
    if (family === 4) {
      atyp = 0x01;
      address = Buffer.from(targetHost.split('.').map((octet) => parseInt(octet, 10)));
    } else if (family === 6) {
      atyp = 0x04;
      address = ipv6ToBuffer(targetHost);
    } else {
      atyp = 0x03; // domain name
      const name = Buffer.from(targetHost, 'utf8');
      address = Buffer.concat([Buffer.from([name.length]), name]);
    }
    const port = Buffer.from([(targetPort >>> 8) & 0xff, targetPort & 0xff]);
    const connectRequest = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00]), // VER, CMD=CONNECT, RSV
      Buffer.from([atyp]),
      address,
      port,
    ]);

    let buffer = Buffer.alloc(0);
    let stage = 'greetingReply';

    socket.on('connect', () => {
      // Greeting: version 5, 1 method offered, NO-AUTH (0x00).
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 'greetingReply') {
        if (buffer.length < 2) return;
        const [version, method] = [buffer[0], buffer[1]];
        if (version !== 0x05 || method !== 0x00) {
          return fail(new Error(`SOCKS5 auth method rejected (version=${version}, method=${method})`));
        }
        buffer = buffer.subarray(2);
        stage = 'connectReply';
        socket.write(connectRequest);
      }

      if (stage === 'connectReply') {
        if (buffer.length < 4) return;
        const reply = buffer[1];
        if (reply !== 0x00) {
          return fail(new Error(`SOCKS5 CONNECT failed (reply=${reply})`));
        }
        const replyAtyp = buffer[3];
        let addrLen;
        if (replyAtyp === 0x01) {
          addrLen = 4;
        } else if (replyAtyp === 0x04) {
          addrLen = 16;
        } else if (replyAtyp === 0x03) {
          if (buffer.length < 5) return;
          addrLen = 1 + buffer[4];
        } else {
          return fail(new Error(`SOCKS5 bad reply ATYP (${replyAtyp})`));
        }
        const need = 4 + addrLen + 2; // header + addr + port
        if (buffer.length < need) return;
        stage = 'done';
        succeed();
      }
    });
  });
}

function ipv6ToBuffer(addr) {
  const buf = Buffer.alloc(16);
  const groups = addr.replace(/::/g, () => {
    // Expand '::' into the appropriate number of zero groups relative to
    // the leading non-empty groups. `groups.length` at call time is wrong,
    // so this helper is replaced below by a proper expansion.
    return '';
  });
  void groups;
  return ipv6Parse(addr, buf);
}

function ipv6Parse(addr, buf) {
  const [head, tail] = addr.indexOf('::') === -1 ? [addr, null] : addr.split('::');
  const headParts = head && head.length ? head.split(':') : [];
  let idx = 0;
  const writeParts = (parts) => {
    for (const part of parts) {
      if (part === '') continue;
      const word = parseInt(part, 16);
      buf[idx++] = (word >>> 8) & 0xff;
      buf[idx++] = word & 0xff;
    }
  };
  writeParts(headParts);
  if (tail !== null) {
    const fill = 8 - headParts.length - (tail.split(':').filter(Boolean).length);
    idx += fill * 2;
    writeParts(tail.split(':').filter(Boolean));
  }
  return buf;
}

module.exports = { socks5Connect };