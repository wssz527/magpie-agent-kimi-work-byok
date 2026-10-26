import dgram from 'node:dgram';
import { isIP } from 'node:net';

export const BYOK_DOMAIN = 'dev.msh.team';
export const BYOK_ADDRESS = '10.255.255.254';
export const BYOK_DNS_PORT = 53535;

// The comment line is part of the file bytes, not decoration: an installed
// resolver is compared byte for byte before it is replaced or removed, so
// changing it would strand every earlier installation behind a conflict.
const HEADER = '# Magpie Kimi Work native BYOK';

export function nativePrivateAddress(address) {
  if (isIP(address) === 6) return /^f[cd]/i.test(address);
  if (isIP(address) !== 4) return false;
  const parts = address.split('.').map(Number);
  return parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
    || parts[0] === 192 && parts[1] === 168;
}

export function resolverConfiguration(port = BYOK_DNS_PORT, resolvePath = '/etc/resolver/' + BYOK_DOMAIN) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('invalid_dns_port');
  return { path: resolvePath,
    content: HEADER + '\nnameserver 127.0.0.1\nport ' + port + '\ntimeout 1\n' };
}

export function dnsReply(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 12 || packet.length > 4096 || packet.readUInt16BE(2) & 0x8000) return null;
  const flags = packet.readUInt16BE(2);
  let offset = 12;
  const labels = [];
  if (packet.readUInt16BE(4) !== 1 || flags & 0x7800) return null;
  while (offset < packet.length) {
    const length = packet[offset++];
    if (!length) break;
    if (length > 63 || offset + length > packet.length) return null;
    const label = packet.subarray(offset, offset + length).toString('ascii');
    if (!/^[a-z0-9-]+$/i.test(label)) return null;
    labels.push(label);
    offset += length;
    if (labels.join('.').length > 253) return null;
  }
  if (offset + 4 > packet.length) return null;
  const type = packet.readUInt16BE(offset), dnsClass = packet.readUInt16BE(offset + 2);
  const allowed = labels.join('.').toLowerCase() === BYOK_DOMAIN && dnsClass === 1 && [1, 28].includes(type);
  const answer = allowed && type === 1;
  const question = packet.subarray(12, offset + 4);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(packet.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8400 | flags & 0x0100 | (allowed ? 0 : 5), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answer ? 1 : 0, 6);
  if (!answer) return Buffer.concat([header, question]);
  const record = Buffer.alloc(16);
  record.writeUInt16BE(0xc00c, 0);
  record.writeUInt16BE(1, 2);
  record.writeUInt16BE(1, 4);
  record.writeUInt32BE(1, 6);
  record.writeUInt16BE(4, 10);
  Buffer.from(BYOK_ADDRESS.split('.').map(Number)).copy(record, 12);
  return Buffer.concat([header, question, record]);
}

export class NativeByokDNS {
  async start(port = BYOK_DNS_PORT) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('invalid_dns_port');
    if (this.socket && this.port === port) return;
    await this.stop();
    const socket = dgram.createSocket('udp4');
    socket.on('message', (packet, sender) => {
      const response = dnsReply(packet);
      if (response) socket.send(response, sender.port, sender.address, () => {});
    });
    try {
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(port, '127.0.0.1', resolve);
      });
    } catch {
      try { socket.close(); } catch {}
      throw Error('native_byok_dns_unavailable');
    }
    socket.on('error', () => {});
    this.socket = socket;
    this.port = port;
    this.address = socket.address();
  }

  async stop() {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    await new Promise(resolve => socket.close(resolve));
  }
}
