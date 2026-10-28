import { BrandMark } from "@/app/brand";
import { SignOutButton } from "@/app/sign-out-button";

export function PausedNotice({ clinicName, cancelled }: { clinicName: string; cancelled: boolean }) {
  const contact = process.env.SUPPORT_CONTACT;
  return (
    <main className="workspace-center">
      <div className="workspace-card">
        <BrandMark />
        <h1>{cancelled ? "This clinic's subscription has ended" : `${clinicName} is paused`}</h1>
        <p className="soft">
          {cancelled
            ? "The dashboard and the WhatsApp assistant are switched off for this clinic."
            : "The dashboard and the WhatsApp assistant are paused for this clinic. Patients who message are asked to call the clinic instead. Your data is kept safe."}
          {contact ? ` To restore access: ${contact}.` : " To restore access, contact your service provider."}
        </p>
        <SignOutButton />
      </div>
    </main>
  );
}
