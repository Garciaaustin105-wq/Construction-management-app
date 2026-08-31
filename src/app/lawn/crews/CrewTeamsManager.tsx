"use client";

// Crew teams manager (lawn, office/admin). Lists the org's crew_teams, and
// covers create / rename / set lead / add+remove members / (de)activate.
//
// Data rules (see the crews/crews RLS — same-org read, office-tier write; no
// manual organization_id filters needed on reads):
//  - Members are picked from the org's crew_members roster. A row with a null
//    user_id is a scheduling-only member (no app login) — normal, rendered as
//    a "no app" chip, never as a broken record.
//  - The lead must be a member of the team (crew_teams.lead_id -> crew_members;
//    team membership is a crew_team_members row). The lead dropdown offers only
//    that team's current members, so an invalid lead can't be picked; RLS does
//    not (and should not) have to police it.
//  - Removed members can't be the lead — the UI bounces that with an explicit
//    message rather than silently dropping a lead off their own team.
//  - Teams are deactivated, never deleted: a team id referenced by
//    lawn_visits.crew_team_id is history this org bills against.

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { Loader2, Plus, Users, UsersRound, Pencil, Check, X, XCircle, Archive, ArchiveRestore } from "lucide-react";

type Team = {
  id: string;
  name: string;
  active: boolean;
  lead_id: string | null;
};

type CrewMember = {
  id: string;
  name: string;
  user_id: string | null; // null = scheduling-only (no app login)
  phone: string | null;
};

type Membership = {
  id: string;
  crew_team_id: string;
  crew_member_id: string;
};

const TEAM_COLS = "id, name, active, lead_id";
const MEMBER_COLS = "id, name, user_id, phone";

export default function CrewTeamsManager({ orgId }: { orgId: string }) {
  const supabase = createClient();
  const toast = useToast();

  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<CrewMember[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Create form
  const [newName, setNewName] = useState("");

  // Inline rename
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");

  // Per-team "add member" picker
  const [addPick, setAddPick] = useState<Record<string, string>>({});

  const memberById = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, m])),
    [members]
  );

  const membersByTeam = useMemo(() => {
    const map: Record<string, CrewMember[]> = {};
    for (const ms of memberships) {
      const m = memberById[ms.crew_member_id];
      if (m) (map[ms.crew_team_id] ??= []).push(m);
    }
    return map;
  }, [memberships, memberById]);

  async function load() {
    // RLS scopes all three reads to the caller's org — no manual filters.
    const [teamsR, membersR, msR] = await Promise.all([
      supabase.from("crew_teams").select(TEAM_COLS).order("name"),
      supabase.from("crew_members").select(MEMBER_COLS).order("name"),
      supabase
        .from("crew_team_members")
        .select("id, crew_team_id, crew_member_id")
        .order("created_at"),
    ]);
    setTeams((teamsR.data as Team[]) ?? []);
    setMembers((membersR.data as CrewMember[]) ?? []);
    setMemberships((msR.data as Membership[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    (async () => {
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createTeam(e: React.FormEvent) {
    e.preventDefault();
    const n = newName.trim();
    if (!n) {
      toast.warning("Team name is required");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("crew_teams").insert({
      name: n,
      organization_id: orgId,
      active: true,
    });
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Team created");
      setNewName("");
      await load();
    }
    setSaving(false);
  }

  async function saveRename(team: Team) {
    const n = renameName.trim();
    if (!n) {
      toast.warning("Team name is required");
      return;
    }
    const { error } = await supabase
      .from("crew_teams")
      .update({ name: n })
      .eq("id", team.id);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Renamed");
      setRenameId(null);
      await load();
    }
  }

  async function setLead(team: Team, memberId: string) {
    const { error } = await supabase
      .from("crew_teams")
      .update({ lead_id: memberId || null })
      .eq("id", team.id);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success(memberId ? "Lead updated" : "Lead cleared");
      await load();
    }
  }

  async function addMember(team: Team) {
    const memberId = addPick[team.id];
    if (!memberId) {
      toast.warning("Pick a crew member first");
      return;
    }
    setSaving(true);
    // ignoreDuplicates: the (crew_team_id, crew_member_id) unique index makes a
    // re-add a no-op rather than an error surfacing to the office.
    const { error } = await supabase
      .from("crew_team_members")
      .upsert(
        {
          organization_id: orgId,
          crew_team_id: team.id,
          crew_member_id: memberId,
        },
        { onConflict: "crew_team_id,crew_member_id", ignoreDuplicates: true }
      );
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Member added");
      setAddPick((prev) => ({ ...prev, [team.id]: "" }));
      await load();
    }
    setSaving(false);
  }

  async function removeMember(team: Team, m: CrewMember) {
    if (team.lead_id === m.id) {
      toast.warning(`${m.name} is the team lead — set a different lead first`);
      return;
    }
    const { error } = await supabase
      .from("crew_team_members")
      .delete()
      .eq("crew_team_id", team.id)
      .eq("crew_member_id", m.id);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Member removed");
      await load();
    }
  }

  async function toggleActive(team: Team) {
    const { error } = await supabase
      .from("crew_teams")
      .update({ active: !team.active })
      .eq("id", team.id);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success(team.active ? "Team deactivated" : "Team reactivated");
      await load();
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-7 h-7 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <section className="space-y-4">
      {/* Create team */}
      <form
        onSubmit={createTeam}
        className="bg-white rounded-lg p-3 shadow-sm space-y-2"
      >
        <p className="text-xs text-gray-500">
          Work is assigned to teams; whoever leads a team confirms head count
          when they start the shift — that number is what turns hours into
          man-hours for pricing.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Team name (e.g. Crew 1 — Mowing)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <button
            type="submit"
            disabled={saving}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold active:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Create
          </button>
        </div>
      </form>

      {/* Teams */}
      {teams.length === 0 ? (
        <div className="bg-white rounded-lg p-6 text-center">
          <Users className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-700">No teams yet</p>
          <p className="text-xs text-gray-500 mt-1 max-w-xs mx-auto">
            Create your first team above, then add members from your crew
            roster (managed on the <span className="font-medium">Team</span>{" "}
            page).
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {teams.map((team) => {
            const teamMembers = membersByTeam[team.id] ?? [];
            const roster = members.filter(
              (m) => !teamMembers.some((tm) => tm.id === m.id)
            );
            const lead = team.lead_id ? memberById[team.lead_id] : undefined;
            return (
              <div
                key={team.id}
                className={`bg-white rounded-lg shadow-sm divide-y divide-gray-100 ${
                  team.active ? "" : "opacity-60"
                }`}
              >
                {/* Header: name + status */}
                <div className="p-3 flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    {renameId === team.id ? (
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={renameName}
                          onChange={(e) => setRenameName(e.target.value)}
                          className="flex-1 min-w-0 px-2 py-1 border border-gray-300 rounded text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => saveRename(team)}
                          className="text-green-600 p-1.5 rounded hover:bg-green-50 flex-shrink-0"
                          title="Save name"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenameId(null)}
                          className="text-gray-500 p-1.5 rounded hover:bg-gray-100 flex-shrink-0"
                          title="Cancel"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <p className="text-sm font-semibold text-gray-900 truncate flex items-center gap-1.5">
                          {team.name}
                          {!team.active && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium uppercase">
                              Inactive
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-gray-500">
                          {teamMembers.length}{" "}
                          {teamMembers.length === 1 ? "member" : "members"}
                          {lead ? ` · lead: ${lead.name}` : ""}
                        </p>
                      </>
                    )}
                  </div>
                  {renameId !== team.id && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setRenameId(team.id);
                          setRenameName(team.name);
                        }}
                        className="text-gray-500 p-2 rounded hover:bg-gray-100"
                        title="Rename"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleActive(team)}
                        className={
                          team.active
                            ? "text-amber-600 p-2 rounded hover:bg-amber-50"
                            : "text-green-600 p-2 rounded hover:bg-green-50"
                        }
                        title={team.active ? "Deactivate team" : "Reactivate team"}
                      >
                        {team.active ? (
                          <Archive className="w-4 h-4" />
                        ) : (
                          <ArchiveRestore className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {/* Members */}
                <div className="p-3 space-y-2">
                  {teamMembers.length === 0 ? (
                    <p className="text-xs text-gray-500">No members yet.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {teamMembers.map((m) => (
                        <span
                          key={m.id}
                          className="inline-flex items-center gap-1 text-xs bg-gray-50 border border-gray-200 rounded-full pl-2.5 pr-1.5 py-1"
                        >
                          {m.name}
                          {team.lead_id === m.id && (
                            <span title="Team lead" className="inline-flex">
                              <UsersRound className="w-3.5 h-3.5 text-blue-600" />
                            </span>
                          )}
                          {!m.user_id && (
                            <span
                              className="text-[10px] px-1 py-0.5 rounded bg-gray-100 text-gray-500 font-medium uppercase"
                              title="Scheduling only — no app login"
                            >
                              No app
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => removeMember(team, m)}
                            className="text-gray-400 hover:text-red-600 p-0.5"
                            title={`Remove ${m.name} from ${team.name}`}
                          >
                            <XCircle className="w-3.5 h-3.5" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Lead picker — team members only. An empty select means
                      no member is the lead; picking a member makes them lead. */}
                  <label className="block">
                    <span className="text-xs font-medium text-gray-600">
                      Team lead (must be a member of this team)
                    </span>
                    <select
                      value={team.lead_id ?? ""}
                      onChange={(e) => setLead(team, e.target.value)}
                      disabled={teamMembers.length === 0}
                      className="mt-1 block w-full px-2.5 py-2 border border-gray-300 rounded-lg text-sm bg-white disabled:bg-gray-50"
                    >
                      <option value="">No lead set</option>
                      {teamMembers.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  {/* Add member — from the org roster, minus whoever is already on the team */}
                  {roster.length > 0 && (
                    <div className="flex gap-2">
                      <select
                        value={addPick[team.id] ?? ""}
                        onChange={(e) =>
                          setAddPick((prev) => ({ ...prev, [team.id]: e.target.value }))
                        }
                        className="flex-1 min-w-0 px-2.5 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                      >
                        <option value="">Add a crew member…</option>
                        {roster.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                            {m.user_id ? "" : " (no app)"}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => addMember(team)}
                        disabled={saving}
                        className="bg-gray-900 text-white px-3 py-2 rounded-lg text-sm font-semibold active:bg-gray-800 disabled:opacity-50 flex-shrink-0"
                      >
                        Add
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[10px] text-gray-400">
        Teams with past visits can&apos;t be deleted — deactivate them instead
        so the crew-size history they built stays intact.
      </p>
    </section>
  );
}