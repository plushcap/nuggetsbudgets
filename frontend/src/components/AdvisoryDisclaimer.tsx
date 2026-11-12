import React from 'react';
import { Callout } from '@radix-ui/themes';
import { Info } from 'lucide-react';

/**
 * Mandatory disclaimer for AI-generated / estimated investment guidance.
 * Render on any page that shows tax estimates or recommendations.
 */
const AdvisoryDisclaimer: React.FC = () => (
  <Callout.Root color="gray" variant="soft" size="1">
    <Callout.Icon><Info size={16} /></Callout.Icon>
    <Callout.Text>
      Estimates only — informational, not financial or tax advice, and not a recommendation to buy or sell.
      Figures use the marginal rates you supply and your recorded data; confirm with a professional.
    </Callout.Text>
  </Callout.Root>
);

export default AdvisoryDisclaimer;
