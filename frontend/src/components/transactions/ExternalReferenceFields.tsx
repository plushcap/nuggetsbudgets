import React, { useState } from 'react';
import { Box, Flex, Text, TextField } from '@radix-ui/themes';
import { ExternalLink } from 'lucide-react';
import { websiteUrlProblem } from '@nuggets/shared';
import FieldError, { fieldErrorProps } from '../forms/FieldError';
import { websiteHref } from '../../utils/safeUrls';
import { FieldCaption, FieldStatus, ReadOnlyValue, type FieldSaveStatus } from './TransactionFieldParts';

/** The link box's id: Save Changes moves the focus to it when it refuses the link. */
export const LINK_FIELD_ID = 'external_link';

/** The link's text and icon, inline. */
const LinkContent: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Flex as="span" display="inline-flex" align="center" gap="1">
    <ExternalLink size={12} />
    {children}
  </Flex>
);

interface ExternalIdFieldProps {
  editing: boolean;
  status: FieldSaveStatus;
  value: string;
  /** Saved once typing pauses. */
  onChange: (value: string) => void;
}

/** Where the transaction is known elsewhere (an order number); shown only once it has one, or while editing. */
export const ExternalIdField: React.FC<ExternalIdFieldProps> = ({ editing, status, value, onChange }) =>
  editing || value ? (
    <Box>
      <FieldCaption htmlFor={editing ? 'external_transaction_id' : undefined}>
        External Transaction ID
        <FieldStatus {...status} />
      </FieldCaption>
      {editing ? (
        <TextField.Root
          id="external_transaction_id"
          variant="surface"
          size="3"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. a store's order number"
        />
      ) : (
        <ReadOnlyValue>
          <Text color="gray" highContrast>{value || '—'}</Text>
        </ReadOnlyValue>
      )}
    </Box>
  ) : null;

interface ExternalLinkFieldProps {
  editing: boolean;
  status: FieldSaveStatus;
  value: string;
  /** The box's text changed (not saved yet). */
  onChange: (value: string) => void;
  /** The box lost focus holding a web address, or nothing: save it. */
  onCommit: (value: string) => void;
  /** Save Changes was refused for the box's text: say why beside it until the text reads. */
  refused?: boolean | undefined;
}

/**
 * The box's text as the link to save: empty clears it (''), a web address is saved as one (a
 * bare host with https://). Else `link` is null and `problem` says why it is refused.
 */
export const checkedLink = (text: string): { link: string | null; problem: string | null } => {
  if (!text.trim()) return { link: '', problem: null };
  const { url, problem } = websiteUrlProblem(text);
  return problem ? { link: null, problem } : { link: url ?? '', problem: null };
};

/** Why the box's text is refused, or null: empty clears the link; else it must be a web address. */
const linkProblem = (text: string): string | null => checkedLink(text).problem;

/**
 * A link to the transaction elsewhere (a receipt, an order); shown only once it has one, or
 * while editing. Other members open it, so it is checked as a website is before it saves:
 * `javascript:…`, another scheme or a user name in it is refused beside the box, and a
 * bare host (`example.com/r/1`) is saved with https://. Only a web address opens as a link.
 */
export const ExternalLinkField: React.FC<ExternalLinkFieldProps> = ({ editing, status, value, onChange, onCommit, refused = false }) => {
  const [blurProblem, setProblem] = useState<string | null>(null);
  // Leaving the edit drops the text, and its message with it (React's way to adjust state to a prop).
  if (!editing && blurProblem) setProblem(null);
  const problem = blurProblem ?? (refused ? linkProblem(value) : null);
  const href = websiteHref(value);

  /** Save what the box holds, as a web address, unless it isn't one. */
  const commit = (text: string) => {
    const { link, problem: refusal } = checkedLink(text);
    setProblem(refusal);
    if (link === null) return;
    if (link !== text) onChange(link);
    onCommit(link);
  };

  if (!editing && !value) return null;
  return (
    <Box>
      <FieldCaption htmlFor={editing ? LINK_FIELD_ID : undefined}>
        External Link
        <FieldStatus {...status} />
      </FieldCaption>
      {editing ? (
        <>
          <TextField.Root
            id={LINK_FIELD_ID}
            variant="surface"
            size="3"
            type="url"
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              // Once refused, the message goes as soon as the text is a web address.
              if (blurProblem) setProblem(linkProblem(e.target.value));
            }}
            onBlur={(e) => commit(e.target.value)}
            placeholder="https://…"
            {...fieldErrorProps(LINK_FIELD_ID, problem)}
          />
          <FieldError fieldId={LINK_FIELD_ID} message={problem} />
          {/* Open the link in a new tab without leaving the edit page. */}
          {href && !problem && /^https?:\/\//i.test(value.trim()) ? (
            <Box mt="1">
              <Text size="1" asChild>
                <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--accent-11)]">
                  <LinkContent>Open in new tab</LinkContent>
                </a>
              </Text>
            </Box>
          ) : null}
        </>
      ) : (
        <ReadOnlyValue>
          {href ? (
            <Text asChild className="text-[var(--accent-11)]">
              <a href={href} target="_blank" rel="noopener noreferrer">
                <LinkContent>Open link</LinkContent>
              </a>
            </Text>
          ) : (
            <Text color="gray" highContrast>{value || '—'}</Text>
          )}
        </ReadOnlyValue>
      )}
    </Box>
  );
};
