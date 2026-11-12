import React from 'react';
import { Controller, useWatch, type UseFormReturn } from 'react-hook-form';
import { Box, Button, Card, Flex, IconButton, Select, Text, TextField } from '@radix-ui/themes';
import { Save, X } from 'lucide-react';
import type { MerchantRuleFormData } from '../../types/forms';
import FormSelectRoot from '../forms/FormSelectRoot';
import FieldError, { fieldErrorProps } from '../forms/FieldError';
import { MERCHANT_RULE_METHOD_DESCRIPTIONS, MERCHANT_RULE_METHOD_LABELS } from './merchantFields';

interface MerchantRuleFormProps {
  form: UseFormReturn<MerchantRuleFormData>;
  /** Whether it edits a rule (rather than adding one). */
  editing: boolean;
  /** Saves the rule, once the form's values pass the schema. */
  onSave: () => Promise<void>;
  onClose: () => void;
  saving: boolean;
}

/** The merchant rules page's form for a new rule or the one being edited. */
const MerchantRuleForm: React.FC<MerchantRuleFormProps> = ({ form, editing, onSave, onClose, saving }) => {
  const { register, handleSubmit, control, formState: { errors } } = form;
  const method = useWatch({ control, name: 'method' });

  return (
    <Card mb="4">
      <Flex direction="column" gap="4">
        <Flex align="center" justify="between">
          <Text size="5" weight="bold" color="gray" highContrast>
            {editing ? 'Edit Rule' : 'Add New Rule'}
          </Text>
          <IconButton variant="ghost" color="gray" onClick={onClose} aria-label="Close form">
            <X size={20} />
          </IconButton>
        </Flex>

        <form onSubmit={handleSubmit(onSave)}>
          <Flex direction="column" gap="4">
            <Flex direction={{ initial: 'column', md: 'row' }} gap="4">
              <Box flexGrow="1" flexBasis="0%">
                <Text as="label" htmlFor="merchant-rule-method" size="2" weight="medium" color="gray" highContrast>
                  Matching Method
                </Text>
                <Controller
                  control={control}
                  name="method"
                  render={({ field }) => (
                    <FormSelectRoot value={field.value} onValueChange={field.onChange} size="3">
                      <Select.Trigger id="merchant-rule-method" mt="2" style={{ width: '100%' }} />
                      <Select.Content>
                        {Object.entries(MERCHANT_RULE_METHOD_LABELS).map(([value, label]) => (
                          <Select.Item key={value} value={value}>
                            {label}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </FormSelectRoot>
                  )}
                />
                <Text size="1" color="gray" mt="1">
                  {MERCHANT_RULE_METHOD_DESCRIPTIONS[method]}
                </Text>
              </Box>

              <Box flexGrow="1" flexBasis="0%">
                <Text as="label" htmlFor="merchant-rule-text" size="2" weight="medium" color="gray" highContrast>
                  Matching Text
                </Text>
                <TextField.Root
                  id="merchant-rule-text"
                  {...register('matching_text')}
                  placeholder="Enter text to match"
                  size="3"
                  mt="2"
                  {...fieldErrorProps('merchant-rule-text', errors.matching_text)}
                />
                <FieldError fieldId="merchant-rule-text" message={errors.matching_text?.message ?? null} />
              </Box>
            </Flex>

            <Flex gap="3">
              <Button type="button" variant="soft" color="gray" onClick={onClose} size="3">
                Cancel
              </Button>
              <Button type="submit" color="blue" disabled={saving} loading={saving} size="3">
                <Save size={16} />
                {editing ? 'Update Rule' : 'Add Rule'}
              </Button>
            </Flex>
          </Flex>
        </form>
      </Flex>
    </Card>
  );
};

export default MerchantRuleForm;
