import { describe, expect, test } from "bun:test";
import { eligibleTeams, ineligibleBecause, recentAuthors, shortlistTeams } from "./prefilter";
import type { TeamRow } from "./types";

function team(over: Partial<TeamRow> = {}): TeamRow {
  return {
    key: "platform",
    name: "Platform",
    description: "Owns the API gateway.",
    lead_slack_ids: ["U_LEAD"],
    topics: [],
    keywords: [],
    home_channel_ids: [],
    realtime_enabled: true,
    min_confidence: 0.6,
    ...over,
  };
}

const OPTS = { minScore: 1, maxTeams: 3 };

describe("eligibleTeams", () => {
  test("keeps a team with leads, away from home, not in the thread", () => {
    expect(eligibleTeams([team()], "C_OTHER", ["U_A"])).toHaveLength(1);
  });

  test("drops a team with no leads: nobody to tell", () => {
    expect(eligibleTeams([team({ lead_slack_ids: [] })], "C_OTHER", [])).toHaveLength(0);
  });

  test("drops a team in one of its own home channels", () => {
    expect(eligibleTeams([team({ home_channel_ids: ["C_HOME"] })], "C_HOME", [])).toHaveLength(0);
  });

  test("drops a team whose lead is active in the thread", () => {
    expect(eligibleTeams([team()], "C_OTHER", ["U_A", "U_LEAD"])).toHaveLength(0);
  });
});

describe("shortlistTeams", () => {
  test("one keyword hit reaches the bar", () => {
    const got = shortlistTeams("the gateway is down", "C1", [], [team({ keywords: ["gateway"] })], OPTS);
    expect(got).toHaveLength(1);
    expect(got[0]!.score).toBe(1);
  });

  test("a topic hit outweighs a keyword", () => {
    const got = shortlistTeams(
      "problems with api gateway routing today",
      "C1",
      [],
      [team({ topics: ["API gateway routing and rate limits"] })],
      OPTS,
    );
    expect(got[0]!.score).toBe(1.5);
  });

  test("a bare team-name mention scores below the bar", () => {
    expect(shortlistTeams("nice work platform", "C1", [], [team()], OPTS)).toHaveLength(0);
  });

  test("single-word keywords match whole words only", () => {
    expect(shortlistTeams("the ssot is stale", "C1", [], [team({ keywords: ["sso"] })], OPTS)).toHaveLength(0);
    expect(shortlistTeams("our sso is down", "C1", [], [team({ keywords: ["sso"] })], OPTS)).toHaveLength(1);
  });

  test("multi-word keywords match as substrings", () => {
    expect(
      shortlistTeams("raising the rate limit", "C1", [], [team({ keywords: ["rate limit"] })], OPTS),
    ).toHaveLength(1);
  });

  test("ineligible teams never appear, however well they score", () => {
    const t = team({ keywords: ["gateway"], home_channel_ids: ["C1"] });
    expect(shortlistTeams("gateway gateway gateway", "C1", [], [t], OPTS)).toHaveLength(0);
  });

  test("caps at maxTeams, highest score first", () => {
    const teams = [
      team({ key: "a", name: "A", keywords: ["gateway"] }),
      team({ key: "b", name: "B", keywords: ["gateway", "envoy"] }),
      team({ key: "c", name: "C", keywords: ["gateway"] }),
    ];
    const got = shortlistTeams("gateway envoy", "C1", [], teams, { minScore: 1, maxTeams: 2 });
    expect(got).toHaveLength(2);
    expect(got[0]!.team.key).toBe("b");
  });
});

describe("ineligibleBecause", () => {
  test("names the rule that fired", () => {
    expect(ineligibleBecause(team({ lead_slack_ids: [] }), "C1", [])).toBe("no leads");
    expect(ineligibleBecause(team({ home_channel_ids: ["C1"] }), "C1", [])).toContain("home channels");
    expect(ineligibleBecause(team(), "C1", ["U_LEAD"])).toBe("lead U_LEAD is active in the thread");
    expect(ineligibleBecause(team(), "C1", ["U_A"])).toBeNull();
  });
});

describe("recentAuthors", () => {
  const msgs = (ids: (string | null)[]) => ids.map((user_id) => ({ user_id }));

  test("takes the tail, not the whole thread", () => {
    expect(recentAuthors(msgs(["U_LEAD", "U_A", "U_B", "U_C"]), 2)).toEqual(["U_B", "U_C"]);
  });

  test("a lead who only spoke early is not engaged", () => {
    const engaged = recentAuthors(msgs(["U_LEAD", "U_A", "U_B", "U_C"]), 2);
    expect(eligibleTeams([team()], "C_OTHER", engaged)).toHaveLength(1);
  });

  test("...but is engaged while still in the tail", () => {
    const engaged = recentAuthors(msgs(["U_A", "U_B", "U_LEAD"]), 2);
    expect(eligibleTeams([team()], "C_OTHER", engaged)).toHaveLength(0);
  });

  test("deduplicates and skips authorless messages", () => {
    expect(recentAuthors(msgs(["U_A", null, "U_A", "U_B"]), 10)).toEqual(["U_A", "U_B"]);
  });

  test("a window larger than the thread covers all of it", () => {
    expect(recentAuthors(msgs(["U_LEAD", "U_A"]), 99)).toEqual(["U_LEAD", "U_A"]);
  });
});
