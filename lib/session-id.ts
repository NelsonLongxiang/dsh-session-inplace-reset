export function assertSessionId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new TypeError('无效的会话 ID');
}
