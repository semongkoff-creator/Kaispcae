import { Router, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getPrisma } from '../lib/prisma';
import { getConfig } from '../config';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';

// Fase 01 of the mesh-to-SFU migration: minting the credential a browser uses
// to join a LiveKit room.
//
// Nothing calls this yet, and nothing breaks while LiveKit is unconfigured —
// it answers 503 and the app carries on with the mesh exactly as before. That
// is the point of shipping it first: the two servers get wired together and
// proven before a single line of the client media layer is touched.

const livekit = Router();

// Handed out per room entry, so a person walking between rooms asks for one
// each time. Loose enough not to matter, tight enough that a scripted caller
// cannot mint tokens indefinitely.
const tokenRateLimit = rateLimit(60 * 1000, 30);

/**
 * How long a join credential stays valid.
 *
 * Six hours rather than the CLI default of a day: long enough that nobody is
 * ejected mid-meeting, short enough that a token copied out of a browser's
 * network tab stops working the same working day. It only ever grants entry to
 * one already-authorised room, so the blast radius is small either way.
 */
const TOKEN_TTL_SECONDS = 6 * 60 * 60;

function isConfigured(): boolean {
  const c = getConfig();
  return !!(c.LIVEKIT_API_KEY && c.LIVEKIT_API_SECRET && c.LIVEKIT_URL);
}

/**
 * A LiveKit access token is an ordinary HS256 JWT with LiveKit's own claim
 * shape — so it is signed with the `jsonwebtoken` this codebase already uses
 * rather than pulling in livekit-server-sdk for one function.
 *
 * The shape below is not guessed from documentation: it is what this
 * deployment's own `livekit-cli token create` produced when the server was
 * verified, decoded and matched field for field. `identity` and `name` are
 * both present and both required — LiveKit reads identity for routing and name
 * for display, and omitting either produces a participant that connects but
 * shows up nameless.
 */
function mintToken(identity: string, name: string, room: string): string {
  const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = getConfig();
  const now = Math.floor(Date.now() / 1000);

  return jwt.sign(
    {
      iss: LIVEKIT_API_KEY,
      sub: identity,
      nbf: now,
      exp: now + TOKEN_TTL_SECONDS,
      identity,
      name,
      video: {
        roomJoin: true,
        room,
        // Explicit rather than left to LiveKit's defaults. Every participant
        // in this product speaks, shows a camera and shares a screen, and
        // subscribes to others — but writing it down means a future change to
        // those defaults cannot silently alter what everyone is allowed to do.
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      },
    },
    LIVEKIT_API_SECRET as string,
    { algorithm: 'HS256' },
  );
}

// POST /api/livekit/token  { roomSlug }  →  { token, url, identity }
livekit.post('/livekit/token', authenticateToken, tokenRateLimit, async (req: AuthRequest, res: Response) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'LiveKit is not configured on this deployment' });
    }
    if (!req.organizationId) return res.status(401).json({ error: 'Authentication required' });

    const roomSlug = typeof req.body?.roomSlug === 'string' ? req.body.roomSlug : '';
    if (!roomSlug) return res.status(400).json({ error: 'roomSlug is required' });

    const prisma = getPrisma();
    const room = await prisma.room.findUnique({
      where: { slug: roomSlug },
      select: { id: true, slug: true, organizationId: true },
    });

    // Deliberately the SAME three checks, in the same order and with the same
    // 404, as GET /rooms/:slug in routes/rooms.ts. A media credential must not
    // be easier to obtain than the room itself: if these two ever disagree,
    // the looser one becomes the way in, and it would be this one — nobody
    // thinks of the token endpoint when tightening room access.
    if (!room || room.organizationId !== req.organizationId) {
      return res.status(404).json({ error: 'Room not found' });
    }
    // undefined means the auth lookup threw and this account's restriction was
    // never resolved. That is not the same as null (confirmed unrestricted)
    // and must fail closed — see routes/rooms.ts for the original reasoning.
    if (req.restrictedToRoomId === undefined) {
      return res.status(404).json({ error: 'Room not found' });
    }
    if (req.restrictedToRoomId && room.id !== req.restrictedToRoomId) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { id: true, displayName: true },
    });
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    // The user id, not the socket id: a LiveKit identity has to survive a
    // reconnect, and a socket id does not. It is also what lets the client
    // match a LiveKit participant back to a player record on the map.
    const token = mintToken(user.id, user.displayName, room.slug);

    return res.json({
      token,
      url: getConfig().LIVEKIT_URL,
      identity: user.id,
    });
  } catch (err) {
    console.error('[livekit] token mint failed:', err);
    return res.status(500).json({ error: 'Could not issue a LiveKit token' });
  }
});

export default livekit;
