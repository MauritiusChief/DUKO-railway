/** Auto worker 状态路由。 */

import { Router } from 'express';
import { getAutoOnlineState } from '../services/ws-state.js';

export const autoWorkerRouter = Router();

autoWorkerRouter.get('/auto-worker/status', (_req, res) => {
  res.json({ autoOnline: getAutoOnlineState().online });
});
