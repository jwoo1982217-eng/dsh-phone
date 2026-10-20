/** Keep the desktop's browser session on its own side of the encrypted tunnel. */
export function browserSessionHeaders(connection, port) {
  let pending;
  return async () => {
    if (typeof connection.authenticatedUrl !== 'function') return {};
    pending ??= (async () => {
      const root = `http://127.0.0.1:${port}/`;
      const response = await fetch(connection.authenticatedUrl(root), {
        redirect: 'manual', signal: AbortSignal.timeout(5000),
      });
      await response.body?.cancel();
      const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0])
        .find(value => /^dsh-auth-[A-Za-z0-9_-]+=/.test(value));
      if (response.status !== 303 || !cookie) throw Error('Desktop browser authentication unavailable');
      return { cookie };
    })().catch(error => { pending = undefined; throw error; });
    return pending;
  };
}
