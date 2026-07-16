// Base URL of the game server (Socket.IO + REST), resolved at runtime from
// whatever host the page itself was opened on — so it works both locally
// (http://localhost:5173 → server at localhost:3001) AND over the LAN
// (http://192.168.x.x:5173 → server at 192.168.x.x:3001) with no hardcoded
// IP. A friend on the same WiFi just opens the host's LAN address and the
// socket automatically points back at the same host's :3001.
//
// Override with VITE_SERVER_URL at build/dev time if the server ever runs on
// a different host/port (e.g. behind a tunnel or a deploy).
export const SERVER_URL: string =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ||
  `${window.location.protocol}//${window.location.hostname}:3001`;
