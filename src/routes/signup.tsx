import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, Loader2, Package } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/signup")({
  component: SignupPage,
});

function SignupPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) navigate({ to: "/" });
  }, [user, loading, navigate]);

  useEffect(() => {
    api<{ bootstrapped: boolean; publicSignup?: boolean }>("/api/auth/status")
      .then((r) => {
        if (!r.bootstrapped) { setAllowed(false); return; }
        setAllowed(r.publicSignup !== false);
      })
      .catch(() => setAllowed(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    setSubmitting(true);
    try {
      // We deliberately bypass the AuthContext signup() helper because the
      // server now returns 202 (pending) instead of a JWT — it cannot log
      // the user in until an admin approves the account.
      await api<{ pending: boolean; email: string; message: string }>(
        "/api/auth/signup",
        { body: { email, password } },
      );
      setSubmitted(email);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign up failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
            {submitted ? (
              <CheckCircle2 className="h-6 w-6 text-primary" />
            ) : (
              <Package className="h-6 w-6 text-primary" />
            )}
          </div>
          <CardTitle>
            {submitted ? "Awaiting approval" : "Create your account"}
          </CardTitle>
          <CardDescription>
            {submitted
              ? `Thanks! Your account for ${submitted} has been created and is now pending review by our team. You'll receive an email once it's approved.`
              : allowed === false
                ? "Self-signup is currently disabled. Please ask an admin for an invite."
                : "Sign up to request access to Ultrax. An admin will review your account before you can sign in."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {submitted ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                In the meantime, you can return to the sign-in page.
              </p>
              <Button asChild className="w-full" variant="outline">
                <Link to="/login">Back to sign in</Link>
              </Button>
            </div>
          ) : allowed === false ? (
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                If you already have an account,{" "}
                <Link to="/login" className="text-foreground font-medium hover:underline">
                  sign in here
                </Link>
                .
              </p>
              <p>
                Have an invite link? Open the link from your email to set a password.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
                <p className="text-xs text-muted-foreground">Minimum 8 characters.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
              </div>
              <Button type="submit" className="w-full" disabled={submitting || allowed === null}>
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Request access
              </Button>
            </form>
          )}
          {!submitted && (
            <p className="text-center text-xs text-muted-foreground mt-6">
              Already have an account?{" "}
              <Link to="/login" className="text-foreground font-medium hover:underline">
                Sign in
              </Link>
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
