import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Truck, ArrowRight } from "lucide-react";
import packetaLogo from "@/assets/integrations/packeta.png";

export const Route = createFileRoute("/integrations/shipping/")({
  component: ShippingOverview,
  head: () => ({
    meta: [
      { title: "Shipping carriers | Ultrax" },
      { name: "description", content: "Connect carriers to print labels straight from your orders." },
    ],
  }),
});

function ShippingOverview() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Truck}
        accent="emerald"
        eyebrow="Connections"
        title="Shipping carriers"
        description="Connect carriers to generate shipping labels straight from the order drawer."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Available carriers</CardTitle>
          <CardDescription>
            Pick a carrier to enter credentials, configure sender address and routing rules.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <CarrierTile
              to="/integrations/shipping/royal-mail"
              icon={<Truck className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />}
              name="Royal Mail"
              description="UK shipments via Click & Drop."
            />
            <CarrierTile
              to="/integrations/shipping/packeta"
              logo={packetaLogo}
              name="Packeta"
              description="EU shipments — pickup points & home delivery."
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CarrierTile({
  to, name, description, icon, logo,
}: {
  to: "/integrations/shipping/royal-mail" | "/integrations/shipping/packeta";
  name: string;
  description: string;
  icon?: React.ReactNode;
  logo?: string;
}) {
  return (
    <Link
      to={to}
      className="group flex items-start gap-3 rounded-lg border p-3 hover:border-foreground/40 hover:bg-accent/40 transition-colors"
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border bg-background">
        {logo ? (
          <img src={logo} alt={`${name} logo`} className="h-9 w-9 object-contain" />
        ) : (
          icon
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 font-semibold text-sm">
          {name}
          <ArrowRight className="h-3.5 w-3.5 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
    </Link>
  );
}
