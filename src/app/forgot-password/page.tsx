import ForgotPasswordForm from "./ForgotPasswordForm";

// Server wrapper for the "forgot password" page. Mirrors the centered-card
// layout of /login and /signup. The actual reset request happens client-side
// (ForgotPasswordForm POSTs to /api/forgot-password, which mints a cross-device
// reset token and emails it via Resend — see password_resets.sql).
export default function ForgotPasswordPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <ForgotPasswordForm />
    </main>
  );
}