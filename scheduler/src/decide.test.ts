import { describe, expect, test } from "bun:test";
import { impactVerdict, type ImpactScores } from "./decide";

function scores(over: Partial<ImpactScores> = {}): ImpactScores {
  return {
    unanswered: 0,
    customer_affecting: 0,
    decision_forming: 0,
    post_type: "discussion",
    post_type_confidence: 1,
    owner: "nobody",
    owner_confidence: 1,
    urgency: 0,
    urgency_label: "",
    ...over,
  };
}

describe("impactVerdict", () => {
  test("drops a confident noise type carrying no impact", () => {
    const v = impactVerdict(scores({ post_type: "ci_alert", post_type_confidence: 0.98, decision_forming: 0.08 }));
    expect(v.drop).toBe(true);
    expect(v.reason).toContain("ci_alert");
  });

  // README scenario 8: an alert with human replies about a real outage is
  // scenario 1, not noise. A noise type is never a drop reason on its own.
  test("keeps a noise type when the impact signal is high", () => {
    const v = impactVerdict(
      scores({ post_type: "ci_alert", post_type_confidence: 0.98, customer_affecting: 0.98 }),
    );
    expect(v.drop).toBe(false);
  });

  test("keeps a noise type the model is unsure of", () => {
    // Needs a real impact signal, or the floor rule below drops it anyway.
    const v = impactVerdict(scores({ post_type: "ci_alert", post_type_confidence: 0.4, unanswered: 0.6 }));
    expect(v.drop).toBe(false);
  });

  test("drops when every impact question is under the floor", () => {
    const v = impactVerdict(scores({ unanswered: 0.14, customer_affecting: 0.03, decision_forming: 0.01 }));
    expect(v.drop).toBe(true);
    expect(v.reason).toContain("no impact signal");
  });

  test("one signal above the floor is enough to reach the judge", () => {
    expect(impactVerdict(scores({ unanswered: 0.2 })).drop).toBe(false);
  });

  // A hedge means "I could not tell", which is the case most worth escalating.
  test("escalates a hedged answer rather than dropping it", () => {
    expect(impactVerdict(scores({ unanswered: 0.5 })).drop).toBe(false);
  });
});
