import ForgotPasswordForm from "./ForgotPasswordForm";

// Server wrapper for the "forgot password" page. Mirrors the centered-card
// layout of /login and /signup. The actual reset request happens client-side
// (ForgotPasswordForm calls supabase.auth.resetPasswordForEmail, a public
// endpoint using the anon key — no API route needed).
export default function ForgotPasswordPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <ForgotPasswordForm />
    </main>
  );
}