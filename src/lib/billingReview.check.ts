import { strict as assert } from "node:assert";
import { buildReview, ReviewInput, ReviewSummary } from "./billingReview";

const cases: { name: string; body: () => void }[] = [
  {
    name: "Empty input returns zero summary",
    body: () => {
      const actual = buildReview([]);
      const expected: ReviewSummary = {
        rows: [],
        medianHourly: null,
        totalPrice: 0,
        totalManHours: 0,
        counts: { ok: 0, under: 0, over: 0, unpriced: 0, unmeasured: 0 },
      };
      assert.deepStrictEqual(actual, expected);
    },
  },
  {
    name: "Measured wins over tapped when both present",
    body: () => {
      const inputs: ReviewInput[] = [
        {
          visitId: "v1",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T10:00:00Z",
          onSiteLastAt: "2026-09-01T10:45:00Z",
          startedAt: "2026-09-01T10:00:00Z",
          completedAt: "2026-09-01T10:45:00Z",
          crewSize: 2,
          pricePerVisit: 100,
        },
      ];
      const actual = buildReview(inputs);
      const expected: ReviewSummary = {
        rows: [
          {
            visitId: "v1",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 45,
            minutesSource: "measured",
            manHours: 1.5,
            price: 100,
            impliedHourly: 66.67,
            verdict: "ok",
          },
        ],
        medianHourly: null,
        totalPrice: 100,
        totalManHours: 1.5,
        counts: { ok: 1, under: 0, over: 0, unpriced: 0, unmeasured: 0 },
      };
      assert.deepStrictEqual(actual, expected);
    },
  },
  {
    name: "Falls back to tapped when measured missing",
    body: () => {
      const inputs: ReviewInput[] = [
        {
          visitId: "v2",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: null,
          onSiteLastAt: null,
          startedAt: "2026-09-01T10:00:00Z",
          completedAt: "2026-09-01T10:30:00Z",
          crewSize: 1,
          pricePerVisit: 50,
        },
      ];
      const actual = buildReview(inputs);
      const expected: ReviewSummary = {
        rows: [
          {
            visitId: "v2",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 30,
            minutesSource: "tapped",
            manHours: 0.5,
            price: 50,
            impliedHourly: 100,
            verdict: "ok",
          },
        ],
        medianHourly: null,
        totalPrice: 50,
        totalManHours: 0.5,
        counts: { ok: 1, under: 0, over: 0, unpriced: 0, unmeasured: 0 },
      };
      assert.deepStrictEqual(actual, expected);
    },
  },
  {
    name: "Falls back to tapped when onSiteLastAt <= onSiteFirstAt",
    body: () => {
      const inputs: ReviewInput[] = [
        {
          visitId: "v3",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T10:00:00Z",
          onSiteLastAt: "2026-09-01T09:50:00Z",
          startedAt: "2026-09-01T10:00:00Z",
          completedAt: "2026-09-01T10:30:00Z",
          crewSize: 1,
          pricePerVisit: 50,
        },
      ];
      const actual = buildReview(inputs);
      const expected: ReviewSummary = {
        rows: [
          {
            visitId: "v3",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 30,
            minutesSource: "tapped",
            manHours: 0.5,
            price: 50,
            impliedHourly: 100,
            verdict: "ok",
          },
        ],
        medianHourly: null,
        totalPrice: 50,
        totalManHours: 0.5,
        counts: { ok: 1, under: 0, over: 0, unpriced: 0, unmeasured: 0 },
      };
      assert.deepStrictEqual(actual, expected);
    },
  },
  {
    name: "crewSize null leads to unmeasured",
    body: () => {
      const inputs: ReviewInput[] = [
        {
          visitId: "v4",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T10:00:00Z",
          onSiteLastAt: "2026-09-01T10:30:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: null,
          pricePerVisit: 50,
        },
      ];
      const actual = buildReview(inputs);
      const expected: ReviewSummary = {
        rows: [
          {
            visitId: "v4",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 30,
            minutesSource: "measured",
            manHours: null,
            price: 50,
            impliedHourly: null,
            verdict: "unmeasured",
          },
        ],
        medianHourly: null,
        totalPrice: 50,
        totalManHours: 0,
        counts: { ok: 0, under: 0, over: 0, unpriced: 0, unmeasured: 1 },
      };
      assert.deepStrictEqual(actual, expected);
    },
  },
  {
    name: "crewSize 0 treated as unmeasured",
    body: () => {
      const inputs: ReviewInput[] = [
        {
          visitId: "v5",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T10:00:00Z",
          onSiteLastAt: "2026-09-01T10:30:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 0,
          pricePerVisit: 50,
        },
      ];
      const actual = buildReview(inputs);
      const expected: ReviewSummary = {
        rows: [
          {
            visitId: "v5",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 30,
            minutesSource: "measured",
            manHours: null,
            price: 50,
            impliedHourly: null,
            verdict: "unmeasured",
          },
        ],
        medianHourly: null,
        totalPrice: 50,
        totalManHours: 0,
        counts: { ok: 0, under: 0, over: 0, unpriced: 0, unmeasured: 1 },
      };
      assert.deepStrictEqual(actual, expected);
    },
  },
  {
    name: "pricePerVisit null leads to unpriced",
    body: () => {
      const inputs: ReviewInput[] = [
        {
          visitId: "v6",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T10:00:00Z",
          onSiteLastAt: "2026-09-01T10:30:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: null,
        },
      ];
      const actual = buildReview(inputs);
      const expected: ReviewSummary = {
        rows: [
          {
            visitId: "v6",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 30,
            minutesSource: "measured",
            manHours: 0.5,
            price: null,
            impliedHourly: null,
            verdict: "unpriced",
          },
        ],
        medianHourly: null,
        totalPrice: 0,
        totalManHours: 0.5,
        counts: { ok: 0, under: 0, over: 0, unpriced: 1, unmeasured: 0 },
      };
      assert.deepStrictEqual(actual, expected);
    },
  },
  {
    name: "Fewer than 3 priced+measured rows => all ok, median null",
    body: () => {
      const inputs: ReviewInput[] = [
        {
          visitId: "v7",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T10:00:00Z",
          onSiteLastAt: "2026-09-01T10:30:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 50,
        },
        {
          visitId: "v8",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T11:00:00Z",
          onSiteLastAt: "2026-09-01T12:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 2,
          pricePerVisit: 120,
        },
      ];
      const actual = buildReview(inputs);
      const expected: ReviewSummary = {
        rows: [
          {
            visitId: "v7",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 30,
            minutesSource: "measured",
            manHours: 0.5,
            price: 50,
            impliedHourly: 100,
            verdict: "ok",
          },
          {
            visitId: "v8",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 2,
            price: 120,
            impliedHourly: 60,
            verdict: "ok",
          },
        ],
        medianHourly: null,
        totalPrice: 170,
        totalManHours: 2.5,
        counts: { ok: 2, under: 0, over: 0, unpriced: 0, unmeasured: 0 },
      };
      assert.deepStrictEqual(actual, expected);
    },
  },
  {
    name: "Clear under and over against median",
    body: () => {
      const inputs: ReviewInput[] = [
        {
          visitId: "v9a",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T08:00:00Z",
          onSiteLastAt: "2026-09-01T09:30:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 2,
          pricePerVisit: 120,
        },
        {
          visitId: "v9b",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T10:00:00Z",
          onSiteLastAt: "2026-09-01T11:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 40,
        },
        {
          visitId: "v9c",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T12:00:00Z",
          onSiteLastAt: "2026-09-01T14:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 3,
          pricePerVisit: 60,
        },
      ];
      const actual = buildReview(inputs);
      const expected: ReviewSummary = {
        rows: [
          {
            visitId: "v9c",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 120,
            minutesSource: "measured",
            manHours: 6,
            price: 60,
            impliedHourly: 10,
            verdict: "under",
          },
          {
            visitId: "v9a",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 90,
            minutesSource: "measured",
            manHours: 3,
            price: 120,
            impliedHourly: 40,
            verdict: "ok",
          },
          {
            visitId: "v9b",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 1,
            price: 40,
            impliedHourly: 40,
            verdict: "ok",
          },
        ],
        medianHourly: 40,
        totalPrice: 220,
        totalManHours: 10,
        counts: { ok: 2, under: 1, over: 0, unpriced: 0, unmeasured: 0 },
      };
      assert.deepStrictEqual(actual, expected);
    },
  },
  {
    name: "Median with even count averages two middle values",
    body: () => {
      const inputs: ReviewInput[] = [
        {
          visitId: "v10a",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T08:00:00Z",
          onSiteLastAt: "2026-09-01T09:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 20,
        },
        {
          visitId: "v10b",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T10:00:00Z",
          onSiteLastAt: "2026-09-01T11:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 30,
        },
        {
          visitId: "v10c",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T12:00:00Z",
          onSiteLastAt: "2026-09-01T13:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 40,
        },
        {
          visitId: "v10d",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T14:00:00Z",
          onSiteLastAt: "2026-09-01T15:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 50,
        },
      ];
      const actual = buildReview(inputs);
      const expected: ReviewSummary = {
        rows: [
          {
            visitId: "v10a",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 1,
            price: 20,
            impliedHourly: 20,
            verdict: "under",
          },
          {
            visitId: "v10d",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 1,
            price: 50,
            impliedHourly: 50,
            verdict: "over",
          },
          {
            visitId: "v10b",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 1,
            price: 30,
            impliedHourly: 30,
            verdict: "ok",
          },
          {
            visitId: "v10c",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 1,
            price: 40,
            impliedHourly: 40,
            verdict: "ok",
          },
        ],
        medianHourly: 35,
        totalPrice: 140,
        totalManHours: 4,
        counts: { ok: 2, under: 1, over: 1, unpriced: 0, unmeasured: 0 },
      };
      assert.deepStrictEqual(actual, expected);
    },
  },
  {
    name: "Single extreme outlier does not move median",
    body: () => {
      const inputs: ReviewInput[] = [
        {
          visitId: "v11a",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T08:00:00Z",
          onSiteLastAt: "2026-09-01T09:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 20,
        },
        {
          visitId: "v11b",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T10:00:00Z",
          onSiteLastAt: "2026-09-01T11:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 30,
        },
        {
          visitId: "v11c",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T12:00:00Z",
          onSiteLastAt: "2026-09-01T13:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 40,
        },
        {
          visitId: "v11d",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T14:00:00Z",
          onSiteLastAt: "2026-09-01T15:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 50,
        },
        {
          visitId: "v11e",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T16:00:00Z",
          onSiteLastAt: "2026-09-01T18:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 1200,
        },
      ];
      const actual = buildReview(inputs);
      const expected: ReviewSummary = {
        rows: [
          {
            visitId: "v11a",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 1,
            price: 20,
            impliedHourly: 20,
            verdict: "under",
          },
          {
            visitId: "v11e",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 120,
            minutesSource: "measured",
            manHours: 2,
            price: 1200,
            impliedHourly: 600,
            verdict: "over",
          },
          {
            visitId: "v11b",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 1,
            price: 30,
            impliedHourly: 30,
            verdict: "ok",
          },
          {
            visitId: "v11c",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 1,
            price: 40,
            impliedHourly: 40,
            verdict: "ok",
          },
          {
            visitId: "v11d",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 1,
            price: 50,
            impliedHourly: 50,
            verdict: "ok",
          },
        ],
        medianHourly: 40,
        totalPrice: 1340,
        totalManHours: 6,
        counts: { ok: 3, under: 1, over: 1, unpriced: 0, unmeasured: 0 },
      };
      assert.deepStrictEqual(actual, expected);
    },
  },
  {
    name: "Sort order puts under before ok",
    body: () => {
      const inputs: ReviewInput[] = [
        {
          visitId: "v12a",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T08:00:00Z",
          onSiteLastAt: "2026-09-01T09:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 40,
        },
        {
          visitId: "v12b",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T10:00:00Z",
          onSiteLastAt: "2026-09-01T11:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 40,
        },
        {
          visitId: "v12c",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T12:00:00Z",
          onSiteLastAt: "2026-09-01T13:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 40,
        },
        {
          visitId: "v12d",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T14:00:00Z",
          onSiteLastAt: "2026-09-01T15:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 10,
        },
      ];
      const actual = buildReview(inputs);
      const expected: ReviewSummary = {
        rows: [
          {
            visitId: "v12d",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 1,
            price: 10,
            impliedHourly: 10,
            verdict: "under",
          },
          {
            visitId: "v12a",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 1,
            price: 40,
            impliedHourly: 40,
            verdict: "ok",
          },
          {
            visitId: "v12b",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 1,
            price: 40,
            impliedHourly: 40,
            verdict: "ok",
          },
          {
            visitId: "v12c",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 1,
            price: 40,
            impliedHourly: 40,
            verdict: "ok",
          },
        ],
        medianHourly: 40,
        totalPrice: 130,
        totalManHours: 4,
        counts: { ok: 3, under: 1, over: 0, unpriced: 0, unmeasured: 0 },
      };
      assert.deepStrictEqual(actual, expected);
    },
  },
  {
    name: "Totals ignore nulls",
    body: () => {
      const inputs: ReviewInput[] = [
        {
          visitId: "v13a",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T08:00:00Z",
          onSiteLastAt: "2026-09-01T08:30:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: null,
        },
        {
          visitId: "v13b",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T09:00:00Z",
          onSiteLastAt: "2026-09-01T10:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 50,
        },
        {
          visitId: "v13c",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T11:00:00Z",
          onSiteLastAt: "2026-09-01T11:30:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: null,
          pricePerVisit: 30,
        },
      ];
      const actual = buildReview(inputs);
      const expected: ReviewSummary = {
        rows: [
          {
            visitId: "v13c",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 30,
            minutesSource: "measured",
            manHours: null,
            price: 30,
            impliedHourly: null,
            verdict: "unmeasured",
          },
          {
            visitId: "v13a",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 30,
            minutesSource: "measured",
            manHours: 0.5,
            price: null,
            impliedHourly: null,
            verdict: "unpriced",
          },
          {
            visitId: "v13b",
            jobName: "job",
            customerName: null,
            dueDate: "2026-09-01",
            minutes: 60,
            minutesSource: "measured",
            manHours: 1,
            price: 50,
            impliedHourly: 50,
            verdict: "ok",
          },
        ],
        medianHourly: null,
        totalPrice: 80,
        totalManHours: 1.5,
        counts: { ok: 1, under: 0, over: 0, unpriced: 1, unmeasured: 1 },
      };
      assert.deepStrictEqual(actual, expected);
    },
  },
  {
    name: "Zero-minute window is unmeasured, not silently ok",
    body: () => {
      const inputs: ReviewInput[] = [
        {
          visitId: "v14a",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T08:00:00Z",
          onSiteLastAt: "2026-09-01T09:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 40,
        },
        {
          visitId: "v14b",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T10:00:00Z",
          onSiteLastAt: "2026-09-01T11:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 40,
        },
        {
          visitId: "v14c",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T12:00:00Z",
          onSiteLastAt: "2026-09-01T13:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 40,
        },
        {
          visitId: "v14d",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T14:00:00Z",
          onSiteLastAt: "2026-09-01T14:00:20Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 75,
        },
      ];
      const out = buildReview(inputs);
      const d = out.rows.find((r) => r.visitId === "v14d");
      assert.ok(d);
      assert.strictEqual(d.minutes, 0);
      assert.strictEqual(d.manHours, 0);
      assert.strictEqual(d.impliedHourly, null);
      assert.strictEqual(d.verdict, "unmeasured");
      assert.strictEqual(out.medianHourly, 40);
      assert.strictEqual(out.counts.unmeasured, 1);
    },
  },
  {
    name: "Zero-minute window is unmeasured even with no median",
    body: () => {
      const inputs: ReviewInput[] = [
        {
          visitId: "v15a",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T08:00:00Z",
          onSiteLastAt: "2026-09-01T09:00:00Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 40,
        },
        {
          visitId: "v15b",
          jobName: "job",
          customerName: null,
          dueDate: "2026-09-01",
          onSiteFirstAt: "2026-09-01T10:00:00Z",
          onSiteLastAt: "2026-09-01T10:00:20Z",
          startedAt: null,
          completedAt: null,
          crewSize: 1,
          pricePerVisit: 75,
        },
      ];
      const out = buildReview(inputs);
      // Only one row has a rate, so there is no median. The short visit is
      // still unmeasurable — it must NOT borrow "ok" from the thin-data rule.
      assert.strictEqual(out.medianHourly, null);
      const b = out.rows.find((r) => r.visitId === "v15b");
      assert.ok(b);
      assert.strictEqual(b.minutes, 0);
      assert.strictEqual(b.impliedHourly, null);
      assert.strictEqual(b.verdict, "unmeasured");
      const a = out.rows.find((r) => r.visitId === "v15a");
      assert.ok(a);
      assert.strictEqual(a.verdict, "ok");
      assert.strictEqual(out.counts.unmeasured, 1);
      assert.strictEqual(out.counts.ok, 1);
    },
  },
];

for (const { name, body } of cases) {
  try {
    body();
    console.log(`${name} passed`);
  } catch (e) {
    console.error(`${name} failed`);
    throw e;
  }
}
console.log("All cases passed");
