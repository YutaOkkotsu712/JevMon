export interface ProtocolMessage {
  room: string | null;
  type: string;
  /** Kept intact: challenge strings, JSON and chat can contain pipes. */
  data: string;
}

export function parseFrame(frame: string): ProtocolMessage[] {
  let room: string | null = null;
  const messages: ProtocolMessage[] = [];
  for (const line of frame.split('\n')) {
    if (!line) continue;
    if (line.startsWith('>')) {
      room = line.slice(1) || null;
      continue;
    }
    if (!line.startsWith('|')) {
      messages.push({ room, type: 'text', data: line });
      continue;
    }
    const separator = line.indexOf('|', 1);
    messages.push({
      room,
      type: separator === -1 ? line.slice(1) : line.slice(1, separator),
      data: separator === -1 ? '' : line.slice(separator + 1),
    });
  }
  return messages;
}
