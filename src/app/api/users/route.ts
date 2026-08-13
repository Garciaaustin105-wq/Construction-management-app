import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  // Verify caller is office
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "office") {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const body = await request.json();
  const { email, password, full_name, role, customer_name } = body;

  if (!email || !password || !role) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (
    !["crew", "superintendent", "project_manager", "office", "customer"].includes(
      role
    )
  ) {
    return NextResponse.json(
      { error: "Invalid role" },
      { status: 400 }
    );
  }

  // Service role client - has admin privileges, bypasses RLS
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Create the auth user
  const { data: authData, error: authError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role, full_name },
      app_metadata: { role },
    });

  if (authError || !authData.user) {
    return NextResponse.json(
      { error: authError?.message ?? "Failed to create user" },
      { status: 500 }
    );
  }

  const newUserId = authData.user.id;

  // Create the profile
  const { error: profileError } = await admin.from("profiles").insert({
    id: newUserId,
    email,
    full_name: full_name || null,
    role,
  });

  if (profileError) {
    // Roll back: delete the auth user
    await admin.auth.admin.deleteUser(newUserId);
    return NextResponse.json(
      { error: `Profile creation failed: ${profileError.message}` },
      { status: 500 }
    );
  }

  // If creating a customer, also create the customer record and LINK the
  // profile to it. Without this link (profiles.customer_id), the new customer
  // sees an empty portal — the customer RLS policies all key off customer_id.
  if (role === "customer") {
    const customerName = customer_name || full_name || email;
    const { data: custData, error: custError } = await admin
      .from("customers")
      .insert({
        name: customerName,
        contact_email: email,
        contact_name: full_name || null,
      })
      .select()
      .single();
    if (custError) {
      // Don't roll back - customer record is optional metadata
    } else if (custData) {
      // Link the new profile to the new customer record
      await admin
        .from("profiles")
        .update({ customer_id: custData.id })
        .eq("id", newUserId);
    }
  }

  return NextResponse.json({ ok: true, userId: newUserId });
}
