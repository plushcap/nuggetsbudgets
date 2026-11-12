import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import express from 'express';
import request from 'supertest';
import { createTagsRoutes } from '../routes/tags.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * A tag's stored level is its depth, and tags stay four levels deep, levels 0 to 3: the
 * triggers give every tag below a moved tag its level, refuse a move or a write that would
 * take a tag past level 3 or make a loop of parents, in one statement or in two transactions
 * at once, and chk_tags_max_level holds levels 0 to 3. Checked as the app writes, on the
 * ledger's own connection (under RLS).
 */

describe('tag levels', () => {
  let tenant: TestTenant;
  let owner: Pool;

  beforeAll(async () => {
    tenant = await createTestTenant('tag levels');
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 1 });
  });

  afterAll(async () => {
    await owner?.end();
    await tenant?.cleanup();
  });

  describe('as the app moves tags', () => {
    const tag = async (name: string, parentId: number | null = null) =>
      (await tenant.pool.query<{ id: number }>('INSERT INTO tags (name, parent_id) VALUES ($1, $2) RETURNING id', [name, parentId])).rows[0].id;
    const levels = async (ids: number[]) =>
      (await tenant.pool.query<{ level: number }>('SELECT level FROM tags WHERE id = ANY($1) ORDER BY array_position($1, id)', [ids])).rows.map(
        (r) => r.level
      );
    const move = (id: number, parentId: number | null) => tenant.pool.query('UPDATE tags SET parent_id = $2 WHERE id = $1', [id, parentId]);

    it('gives every tag below a moved tag its level, one below its parent', async () => {
      const top = await tag('lvl top');
      const child = await tag('lvl child', top);
      const grandchild = await tag('lvl grandchild', child);
      const other = await tag('lvl other');

      await move(top, other);
      expect(await levels([other, top, child, grandchild])).toEqual([0, 1, 2, 3]);
      await move(top, null);
      expect(await levels([top, child, grandchild])).toEqual([0, 1, 2]);

      // Moving the middle one moves only what is below it.
      const second = await tag('lvl second', other);
      await move(child, second);
      expect(await levels([top, other, second, child, grandchild])).toEqual([0, 0, 1, 2, 3]);
    });

    it('refuses a move whose tags below would pass level 3, or that puts a tag under itself or below it', async () => {
      const first = await tag('lvl deep 0');
      const second = await tag('lvl deep 1', first);
      const third = await tag('lvl deep 2', second);
      const subtree = await tag('lvl subtree');
      const below = await tag('lvl subtree child', subtree);

      // Under the level-2 tag the subtree's child would be level 4.
      await expect(move(subtree, third)).rejects.toThrow('Cannot move tag: maximum hierarchy depth of 4 levels exceeded');
      // Under the level-1 one it is level 3.
      await move(subtree, second);
      expect(await levels([subtree, below])).toEqual([2, 3]);

      await expect(move(first, first)).rejects.toThrow('Cannot move tag: would create circular reference');
      await expect(move(first, second)).rejects.toThrow('Cannot move tag: would create circular reference');
      await expect(move(second, subtree)).rejects.toThrow('Cannot move tag: would create circular reference');
      expect(await levels([first, second, third, subtree, below])).toEqual([0, 1, 2, 2, 3]);
    });

    // One statement that moves two tags, one under a tag below the other. The levels
    // were worked out row by row from the new parent's stored level, which the statement's
    // other move hadn't brought down yet: one order of the rows let a tag reach level 4
    // (stored as 3), the other refused a statement that fits. Each case runs with either
    // tag's ids the lower, since a statement writes its rows in no set order.
    describe('in one statement', () => {
      const moveBoth = (moves: Array<[number, number | null]>) =>
        tenant.pool.query(
          `UPDATE tags SET parent_id = m.parent_id FROM unnest($1::int[], $2::int[]) AS m(id, parent_id) WHERE tags.id = m.id`,
          [moves.map(([id]) => id), moves.map(([, parent]) => parent)]
        );
      /** C0 > C1 (under `above` when given), D0, and E0 > E1, E's created first when `eFirst`. */
      const fixture = async (label: string, eFirst: boolean, above: number | null = null) => {
        const e = async () => {
          const e0 = await tag(`lvl ${label} E0`);
          return [e0, await tag(`lvl ${label} E1`, e0)];
        };
        const [e0, e1] = eFirst ? await e() : [0, 0];
        const c0 = await tag(`lvl ${label} C0`, above);
        const c1 = await tag(`lvl ${label} C1`, c0);
        const d0 = await tag(`lvl ${label} D0`);
        const [lateE0, lateE1] = eFirst ? [e0, e1] : await e();
        return { c0, c1, d0, e0: lateE0, e1: lateE1 };
      };

      for (const eFirst of [false, true]) {
        const order = eFirst ? 'E written first' : 'C written first';

        it(`refuses one that would take a tag past level 3 (${order})`, async () => {
          const { c0, c1, d0, e0, e1 } = await fixture(`deep ${order}`, eFirst);
          // D0 > C0 > C1 > E0 > E1: E1 would be at level 4.
          await expect(moveBoth([[c0, d0], [e0, c1]])).rejects.toThrow('maximum hierarchy depth of 4 levels exceeded');
          expect(await levels([d0, c0, c1, e0, e1])).toEqual([0, 0, 1, 0, 1]);
        });

        it(`gives every tag its level in one that fits (${order})`, async () => {
          const p = await tag(`lvl fits ${order} P`);
          const { c0, c1, e0, e1 } = await fixture(`fits ${order}`, eFirst, p);
          // C0 to the top and E0 under C1: C0 > C1 > E0 > E1, levels 0 to 3.
          await moveBoth([[c0, null], [e0, c1]]);
          expect(await levels([c0, c1, e0, e1])).toEqual([0, 1, 2, 3]);
        });
      }

      it('refuses one that would make a loop', async () => {
        const { c0, d0 } = await fixture('loop', false);
        await expect(moveBoth([[c0, d0], [d0, c0]])).rejects.toThrow('would create circular reference');
      });

      // This case: A > B > C > D, then D to the top and B under D, which ends as
      // D > B > C. calculate_tag_level gave B the level one below D's stored one (3) while
      // D's own row wasn't written yet, and chk_tags_max_level refused the 4 before the
      // AFTER trigger set it right: refused when B's row came first.
      for (const dFirst of [false, true]) {
        it(`moves a tag under one the statement moves up (${dFirst ? "D's id the lower" : "B's id the lower"})`, async () => {
          const label = `lvl up ${dFirst ? 'd first' : 'b first'}`;
          const early = dFirst ? await tag(`${label} D`) : 0;
          const a = await tag(`${label} A`);
          const b = await tag(`${label} B`, a);
          const c = await tag(`${label} C`, b);
          const d = dFirst ? early : await tag(`${label} D`);
          await tenant.pool.query('UPDATE tags SET parent_id = $2 WHERE id = $1', [d, c]);
          expect(await levels([a, b, c, d])).toEqual([0, 1, 2, 3]);

          await tenant.pool.query('UPDATE tags SET parent_id = CASE id WHEN $1::int THEN NULL WHEN $2::int THEN $1::int END WHERE id IN ($1, $2)', [d, b]);
          expect(await levels([a, d, b, c])).toEqual([0, 0, 1, 2]);
        });
      }

      // Random statements that each move a few tags of a small forest, checked against the
      // end state worked out here: refused exactly when it has a loop or a tag past level 3,
      // and otherwise every tag at its depth.
      it('decides a few hundred random statements as their end state does', async () => {
        let seed = 7919;
        const random = () => {
          seed = (seed * 1103515245 + 12345) % 2147483648;
          return seed / 2147483648;
        };
        const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)];
        const ids: number[] = [];
        for (let i = 0; i < 8; i++) ids.push(await tag(`lvl fuzz ${i}`));
        const depths = (parents: Map<number, number | null>) => {
          const out = new Map<number, number | null>();
          for (const id of ids) {
            let depth = 0;
            const seen = new Set([id]);
            for (let at = parents.get(id) ?? null; at !== null; at = parents.get(at) ?? null) {
              if (seen.has(at)) {
                depth = -1;
                break;
              }
              seen.add(at);
              depth++;
            }
            out.set(id, depth < 0 ? null : depth);
          }
          return out;
        };
        const move = (client: PoolClient, moves: Map<number, number | null>) =>
          client.query(`UPDATE tags SET parent_id = m.parent_id FROM unnest($1::int[], $2::int[]) AS m(id, parent_id) WHERE tags.id = m.id`, [
            [...moves.keys()],
            [...moves.values()],
          ]);
        const levelsNow = async (client: PoolClient) =>
          new Map((await client.query<{ id: number; level: number }>('SELECT id, level FROM tags WHERE id = ANY($1)', [ids])).rows.map((r) => [r.id, r.level]));

        const client = await tenant.pool.connect();
        let refused = 0;
        try {
          for (let round = 0; round < 300; round++) {
            await client.query('BEGIN');
            // A forest within level 3: each tag under one placed before it, or at the top.
            const start = new Map<number, number | null>();
            const order = [...ids].sort(() => random() - 0.5);
            order.forEach((id, i) => {
              const parent = i === 0 || random() < 0.3 ? null : pick(order.slice(0, i));
              start.set(id, parent);
              if ((depths(start).get(id) ?? 4) > 3) start.set(id, null);
            });
            await move(client, start);
            expect(await levelsNow(client), `round ${round}: the forest`).toEqual(depths(start));

            // Two to four tags moved at once, each under another tag or to the top.
            const moves = new Map<number, number | null>();
            const count = 2 + Math.floor(random() * 3);
            while (moves.size < count) moves.set(pick(ids), random() < 0.25 ? null : pick(ids));
            const end = new Map([...start, ...moves]);
            const expected = depths(end);
            const fits = [...expected.values()].every((depth) => depth !== null && depth <= 3);
            const what = `round ${round}: ${JSON.stringify([...moves])} over ${JSON.stringify([...start])}`;
            await client.query('SAVEPOINT round');
            const error = await move(client, moves).then(
              () => null,
              (err: Error) => err
            );
            if (error) {
              expect(fits, `${what} was refused: ${error.message}`).toBe(false);
              expect(error.message, what).toMatch(/would create circular reference|maximum hierarchy depth of 4 levels exceeded/);
              refused++;
              await client.query('ROLLBACK TO SAVEPOINT round');
            } else {
              expect(fits, `${what} was accepted`).toBe(true);
              expect(await levelsNow(client), `${what}: the levels`).toEqual(expected);
            }
            await client.query('ROLLBACK');
          }
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
          client.release();
        }
        // Both kinds came up.
        expect(refused).toBeGreaterThan(20);
        expect(refused).toBeLessThan(280);
      }, 120_000);

      // One INSERT that adds tags below their parent first: calculate_tag_level found no
      // parent yet, so each such tag got no level and no depth check (a 6-deep chain was
      // taken, at levels 0 and none). trg_calculate_inserted_tag_levels checks and levels
      // each once the statement's rows are written.
      describe('that adds tags', () => {
        const reserveIds = async (count: number) =>
          (await tenant.pool.query<{ id: number }>(`SELECT nextval('tags_id_seq')::int AS id FROM generate_series(1, $1)`, [count])).rows.map(
            (r) => r.id
          );
        /** One INSERT of `rows` ([id, parent]), written in the order given. */
        const insertAll = (label: string, rows: Array<[number, number | null]>) =>
          tenant.pool.query(
            `INSERT INTO tags (id, name, parent_id)
             SELECT r.id, $3 || ' ' || r.n, r.parent_id
               FROM unnest($1::int[], $2::int[]) WITH ORDINALITY AS r(id, parent_id, n)
              ORDER BY r.n`,
            [rows.map(([id]) => id), rows.map(([, parent]) => parent), `lvl insert ${label}`]
          );
        /** A chain of `count` tags, each under the one before; its rows listed bottom first. */
        const chainBottomFirst = async (count: number) => {
          const ids = await reserveIds(count);
          return { ids, rows: ids.map((id, i): [number, number | null] => [id, i === 0 ? null : ids[i - 1]]).reverse() };
        };

        it('levels tags written before their parent', async () => {
          const { ids, rows } = await chainBottomFirst(4);
          await insertAll('fits', rows);
          expect(await levels(ids)).toEqual([0, 1, 2, 3]);
        });

        it('refuses a chain past level 3, or a loop, whatever order its rows are written in', async () => {
          const { ids, rows } = await chainBottomFirst(6);
          await expect(insertAll('deep bottom first', rows)).rejects.toThrow('maximum hierarchy depth of 4 levels exceeded');
          await expect(insertAll('deep top first', [...rows].reverse())).rejects.toThrow('maximum hierarchy depth of 4 levels exceeded');
          const [a, b] = await reserveIds(2);
          await expect(insertAll('loop', [[a, b], [b, a]])).rejects.toThrow('would create circular reference');
          expect((await tenant.pool.query('SELECT id FROM tags WHERE id = ANY($1)', [[...ids, a, b]])).rows).toEqual([]);
        });

        it('refuses a tag under one a statement leaves at level 3', async () => {
          const { ids, rows } = await chainBottomFirst(4);
          await insertAll('under 3 chain', rows);
          const [child] = await reserveIds(1);
          await expect(insertAll('under 3', [[child, ids[3]]])).rejects.toThrow('maximum hierarchy depth of 4 levels exceeded');
        });
      });
    });

    // Two transactions that each move a tag, where the two moves together make a loop or
    // take a tag past level 3: each walked the tags as they were before the other's move,
    // so both were taken (a loop broke every tag list of the ledger). The tag triggers and
    // TagService take a lock for the ledger first, so the second is checked against the
    // first's move once it is committed.
    describe('in two transactions at once', () => {
      /** Resolves once a statement waits for the ledger's tag lock. */
      const someoneWaitsForTheLock = async () => {
        for (let i = 0; i < 200; i++) {
          const { rows } = await tenant.pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted AND classid = 1413564243 AND objid = $1::int::oid AND objsubid = 2`,
            [tenant.tenantId]
          );
          if (rows[0].n > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('nothing waited for the tag lock');
      };
      /** Runs `first` in a transaction, then `second` meanwhile, and commits the first once the second waits. */
      const meanwhile = async <T,>(first: (client: PoolClient) => Promise<unknown>, second: () => Promise<T>): Promise<T> => {
        const client = await tenant.pool.connect();
        try {
          await client.query('BEGIN');
          await first(client);
          const outcome = second().then(
            (value) => ({ value }),
            (error: Error) => ({ error })
          );
          await someoneWaitsForTheLock();
          await client.query('COMMIT');
          const settled = await outcome;
          if ('error' in settled) throw settled.error;
          return settled.value;
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
          client.release();
        }
      };

      it('refuses the second move where the two would make a loop', async () => {
        const c = await tag('lvl race loop C');
        const b = await tag('lvl race loop B', c);
        const a = await tag('lvl race loop A');
        // C > B > A, then C under A.
        await expect(
          meanwhile(
            (client) => client.query('UPDATE tags SET parent_id = $2 WHERE id = $1', [a, b]),
            () => move(c, a)
          )
        ).rejects.toThrow('would create circular reference');
        expect(await levels([c, b, a])).toEqual([0, 1, 2]);
      });

      it('refuses the second where the two would take a tag past level 3, and a new tag too', async () => {
        const top = await tag('lvl race deep top');
        const one = await tag('lvl race deep 1', top);
        const two = await tag('lvl race deep 2', one);
        const x = await tag('lvl race deep X');
        const z = await tag('lvl race deep Z');
        // X under the level-2 tag (level 3), then Z under X.
        await expect(
          meanwhile(
            (client) => client.query('UPDATE tags SET parent_id = $2 WHERE id = $1', [x, two]),
            () => move(z, x)
          )
        ).rejects.toThrow('maximum hierarchy depth of 4 levels exceeded');
        expect(await levels([x, z])).toEqual([3, 0]);

        // A new tag under Y's child (level 1), while Y goes under the level-1 tag, which
        // takes the child to level 3: the new one would be at level 4.
        const y = await tag('lvl race deep Y');
        const yChild = await tag('lvl race deep Y child', y);
        await expect(
          meanwhile(
            (client) => client.query('UPDATE tags SET parent_id = $2 WHERE id = $1', [y, one]),
            () => tag('lvl race deep Y grandchild', yChild)
          )
        ).rejects.toThrow('maximum hierarchy depth of 4 levels exceeded');
        expect(await levels([y, yChild])).toEqual([2, 3]);
      });

      const tagsApi = () => {
        const app = express();
        app.use(express.json());
        app.use(tenant.context());
        app.use('/api/tags', createTagsRoutes());
        return app;
      };
      const uuidOf = async (id: number) => (await tenant.pool.query<{ uuid: string }>('SELECT uuid FROM tags WHERE id = $1', [id])).rows[0].uuid;

      it('answers the app the second move with a 400, its checks seeing the first', async () => {
        const app = tagsApi();
        const c = await tag('lvl race api C');
        const b = await tag('lvl race api B', c);
        const a = await tag('lvl race api A');
        const cUuid = await uuidOf(c);
        const answer = await meanwhile(
          (client) => client.query('UPDATE tags SET parent_id = $2 WHERE id = $1', [a, b]),
          async () => request(app).put(`/api/tags/${cUuid}`).send({ name: 'lvl race api C', parent_id: a })
        );
        expect(answer.status).toBe(400);
        expect(answer.body.message).toBe('Cannot move tag: would create circular reference');
        expect(await levels([c, b, a])).toEqual([0, 1, 2]);
      });

      // A delete counted the tag's children before a move under it was committed, then
      // waited on the move's row and took the moved tag and its child with it (ON DELETE
      // CASCADE): both answered ok, and three tags were gone.
      it("refuses a delete of a tag another request is moving a tag under", async () => {
        const p = await tag('lvl race delete P');
        const y = await tag('lvl race delete Y');
        const yChild = await tag('lvl race delete Y child', y);
        const answer = await meanwhile(
          (client) => client.query('UPDATE tags SET parent_id = $2 WHERE id = $1', [y, p]),
          async () => request(tagsApi()).delete(`/api/tags/${await uuidOf(p)}`)
        );
        expect(answer.status).toBe(400);
        expect(answer.body.error).toBe('Tag has children');
        expect(await levels([p, y, yChild])).toEqual([0, 1, 2]);
      });
    });

    it('checks chk_tags_max_level as levels 0 to 3, validated', async () => {
      const check = (
        await owner.query<{ def: string; convalidated: boolean }>(
          `SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint WHERE conname = 'chk_tags_max_level'`
        )
      ).rows;
      expect(check).toEqual([{ def: 'CHECK (((level >= 0) AND (level <= 3)))', convalidated: true }]);
    });
  });
});
