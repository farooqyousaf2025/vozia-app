import { Request, Response } from 'express';
import { emojiCatalogue } from '../services/emoji.service';
import { asyncHandler } from '../utils/http';

/**
 * `GET /api/emoji` — the codes the chat picker offers and the token grammar that finds them inside
 * a message. Public like `GET /api/rooms/themes`: it carries no member data, only which art the
 * platform is currently showing, and a signed-out login screen may render it.
 */
export const catalog = asyncHandler(async (_req: Request, res: Response) => {
  res.json(await emojiCatalogue());
});
