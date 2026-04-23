import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Mail, Phone, Send, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { AppShell } from "@/components/app-shell";

// Public details — edit these to change what visitors see.
const SUPPORT_EMAIL = "contact@ultrax.work";
const SUPPORT_PHONE = "+44 20 0000 0000"; // TODO: replace with the real number

export const Route = createFileRoute("/contact")({
  component: ContactPage,
  head: () => ({
    meta: [
      { title: "Contact Ultrax — Get in touch with our team" },
      {
        name: "description",
        content:
          "Questions about Ultrax order ops? Email or call us, or send a message and we'll reply within one business day.",
      },
      { property: "og:title", content: "Contact Ultrax" },
      {
        property: "og:description",
        content: "Get in touch with the Ultrax team — email, phone, or message form.",
      },
    ],
  }),
});

function ContactPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await api("/api/contact", {
        method: "POST",
        body: { name, email, phone, subject, message },
      });
      setSent(true);
      toast.success("Message sent — we'll get back to you shortly.");
      setName(""); setEmail(""); setPhone(""); setSubject(""); setMessage("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell>
      <div className="max-w-2xl">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight">Get in touch</h1>
        <p className="mt-4 text-lg text-muted-foreground">
          Whether you'd like a demo, have a question about your account, or need help with an
          integration — drop us a line and a real person will reply within one business day.
        </p>
      </div>

        <div className="mt-12 grid gap-8 md:grid-cols-[1fr,1.4fr]">
          {/* Direct channels */}
          <div className="space-y-4">
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="block group"
            >
              <Card className="transition-all hover:shadow-md hover:border-brand-violet/40">
                <CardContent className="p-5 flex items-start gap-4">
                  <div className="h-11 w-11 rounded-xl bg-brand-violet-soft text-brand-violet flex items-center justify-center shrink-0">
                    <Mail className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground font-semibold">
                      Email us
                    </div>
                    <div className="font-semibold mt-0.5 group-hover:text-brand-violet transition-colors break-all">
                      {SUPPORT_EMAIL}
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">
                      For account, billing, and integration questions.
                    </div>
                  </div>
                </CardContent>
              </Card>
            </a>

            <a
              href={`tel:${SUPPORT_PHONE.replace(/\s+/g, "")}`}
              className="block group"
            >
              <Card className="transition-all hover:shadow-md hover:border-brand-sky/40">
                <CardContent className="p-5 flex items-start gap-4">
                  <div className="h-11 w-11 rounded-xl bg-brand-sky/10 text-brand-sky flex items-center justify-center shrink-0">
                    <Phone className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground font-semibold">
                      Call us
                    </div>
                    <div className="font-semibold mt-0.5 group-hover:text-brand-sky transition-colors">
                      {SUPPORT_PHONE}
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">
                      Mon–Fri, 9am–5pm UK time.
                    </div>
                  </div>
                </CardContent>
              </Card>
            </a>
          </div>

          {/* Form */}
          <Card>
            <CardContent className="p-6 md:p-8">
              {sent ? (
                <div className="py-12 text-center space-y-4">
                  <div className="mx-auto h-14 w-14 rounded-full bg-emerald-500/10 text-emerald-600 flex items-center justify-center">
                    <CheckCircle2 className="h-7 w-7" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold">Message received</h2>
                    <p className="text-sm text-muted-foreground mt-1">
                      Thanks for reaching out — we'll get back to you within one business day.
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => setSent(false)}>
                    Send another message
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">Your name</Label>
                      <Input
                        id="name" required maxLength={100} autoComplete="name"
                        value={name} onChange={(e) => setName(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email" type="email" required maxLength={255} autoComplete="email"
                        value={email} onChange={(e) => setEmail(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="phone">
                        Phone <span className="text-muted-foreground font-normal">(optional)</span>
                      </Label>
                      <Input
                        id="phone" type="tel" maxLength={40} autoComplete="tel"
                        value={phone} onChange={(e) => setPhone(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="subject">
                        Subject <span className="text-muted-foreground font-normal">(optional)</span>
                      </Label>
                      <Input
                        id="subject" maxLength={150}
                        value={subject} onChange={(e) => setSubject(e.target.value)}
                        placeholder="e.g. Demo request"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="message">Message</Label>
                    <Textarea
                      id="message" required rows={6} minLength={10} maxLength={5000}
                      value={message} onChange={(e) => setMessage(e.target.value)}
                      placeholder="How can we help?"
                    />
                    <div className="text-xs text-muted-foreground text-right tabular-nums">
                      {message.length}/5000
                    </div>
                  </div>

                  <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Send message
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
