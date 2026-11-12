import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createPushRoutes } from '../push.js';
import type { PushNotificationService } from '../../services/PushNotificationService.js';

const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }; // gitleaks:allow (made-up)

describe('Push API', () => {
  let app: Express;
  let service: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    service = {
      getPublicKey: vi.fn().mockResolvedValue('BPublicKey'),
      countSubscriptions: vi.fn().mockResolvedValue(2),
      subscribe: vi.fn().mockResolvedValue('sub-uuid'),
      unsubscribe: vi.fn().mockResolvedValue(true),
      sendToUser: vi.fn().mockResolvedValue({ sent: 1, failed: 0, removed: 0 }),
    };
    app = express();
    app.use(express.json());
    // Stands in for authenticateToken.
    app.use((req, _res, next) => {
      (req as typeof req & { user: { userId: number; email: string } }).user = { userId: 42, email: 'pat@example.com' };
      next();
    });
    app.use('/api/push', createPushRoutes({ pushService: service as unknown as PushNotificationService }));
  });

  it('returns the VAPID public key', async () => {
    const res = await request(app).get('/api/push/public-key').expect(200);
    expect(res.body).toEqual({ publicKey: 'BPublicKey' });
  });

  it("saves a browser subscription for the signed-in person", async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    await request(app)
      .post('/api/push/subscriptions')
      .set('User-Agent', 'Pixel')
      .send({ endpoint, expirationTime: null, keys })
      .expect(201, { uuid: 'sub-uuid' });
    expect(service.subscribe).toHaveBeenCalledWith(42, expect.objectContaining({ endpoint, keys }), 'Pixel');
  });

  it.each([
    ['an internal host', 'https://backend:5000/api/users'],
    ['plain http', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['a look-alike host', 'https://fcm.googleapis.com.attacker.example/x'],
  ])('refuses %s as an endpoint', async (_label, endpoint) => {
    await request(app).post('/api/push/subscriptions').send({ endpoint, keys }).expect(400);
    expect(service.subscribe).not.toHaveBeenCalled();
  });

  it('refuses a subscription without keys', async () => {
    await request(app).post('/api/push/subscriptions').send({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }).expect(400);
  });

  it("removes the signed-in person's device", async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    await request(app).post('/api/push/subscriptions/remove').send({ endpoint }).expect(200, { removed: true });
    expect(service.unsubscribe).toHaveBeenCalledWith(42, endpoint);
  });

  it('sends a test notification to the signed-in person only', async () => {
    const res = await request(app).post('/api/push/test').expect(200);
    expect(res.body).toEqual({ sent: 1, failed: 0, removed: 0 });
    expect(service.sendToUser).toHaveBeenCalledWith(42, expect.objectContaining({ url: '/profile' }));
  });
});
