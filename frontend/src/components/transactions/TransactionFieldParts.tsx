import React, { useEffect, useState } from 'react';
import { Box, Flex, Text } from '@radix-ui/themes';
import { CircleCheck } from 'lucide-react';
import NuggetSpinner from '../NuggetSpinner';

/** Whether a field is saving, and when it last saved. */
export interface FieldSaveStatus {
  isSaving: boolean;
  lastSaveTime?: Date | undefined;
}

/** How long a field shows "Saved" after it saved. */
export const SAVED_SHOWN_MS = 10_000;

/**
 * "Saving..." / "Saved" beside a field's caption. It is aria-hidden: the caption names the
 * field ("Type", not "Type Saved"), and the save's toast already announces the outcome
 * (react-hot-toast renders role="status").
 */
export const FieldStatus: React.FC<FieldSaveStatus> = ({ isSaving, lastSaveTime }) => {
  // The save whose "Saved" has had its time; a newer save shows it again.
  const [expired, setExpired] = useState<Date | undefined>(undefined);
  useEffect(() => {
    if (!lastSaveTime) return;
    const left = SAVED_SHOWN_MS - (Date.now() - lastSaveTime.getTime());
    const timer = setTimeout(() => setExpired(lastSaveTime), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [lastSaveTime]);

  if (isSaving) {
    return (
      <Flex asChild display="inline-flex" align="center" gap="1" ml="2">
        <Text size="1" color="gray" aria-hidden="true">
          <NuggetSpinner size={12} />
          Saving...
        </Text>
      </Flex>
    );
  }

  if (lastSaveTime && expired !== lastSaveTime) {
    return (
      <Flex asChild display="inline-flex" align="center" gap="1" ml="2">
        <Text size="1" className="text-[var(--green-12)]" aria-hidden="true">
          <CircleCheck size={12} />
          Saved
        </Text>
      </Flex>
    );
  }

  return null;
};

interface FieldCaptionProps {
  /** The control it names, while the control is on the page (edit mode). */
  htmlFor?: string | undefined;
  /** Its id, for a control named with aria-labelledby (the pickers). */
  id?: string | undefined;
  children: React.ReactNode;
}

/**
 * A field's caption: the <label> of its control while the control is on the page (edit
 * mode), plain text otherwise (a label must point at a control), or the text a picker is
 * named by (`id`).
 */
export const FieldCaption: React.FC<FieldCaptionProps> = ({ htmlFor, id, children }) => (
  <Flex asChild align="center" mb="2">
    {htmlFor ? (
      <Text as="label" htmlFor={htmlFor} size="2" weight="medium">
        {children}
      </Text>
    ) : (
      <Text as="div" id={id} size="2" weight="medium">
        {children}
      </Text>
    )}
  </Flex>
);

/** A field's value while it isn't edited, on a gray panel. */
export const ReadOnlyValue: React.FC<{ minHeight?: string; children: React.ReactNode }> = ({ minHeight, children }) => (
  <Box px="4" py="3" className="rounded-[var(--radius-3)] bg-[var(--gray-3)]" {...(minHeight ? { minHeight } : {})}>
    {children}
  </Box>
);
