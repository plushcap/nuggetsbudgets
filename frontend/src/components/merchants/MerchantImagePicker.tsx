import React, { useId, useState } from 'react';
import { Box } from '@radix-ui/themes';
import { Upload } from 'lucide-react';
import FilePickerButton from '../forms/FilePickerButton';
import FieldError, { fieldErrorDescribedBy } from '../forms/FieldError';
import { IMAGE_UPLOAD_TYPES, imageUploadProblem } from '../../utils/imageUploads';

interface MerchantImagePickerProps {
  label: string;
  /** The picture picked, once it is one the server takes (imageUploadProblem). */
  onChoose: (file: File) => void;
}

/**
 * The merchant form's image picker: a button that opens the file chooser (FilePickerButton),
 * so keyboard and screen-reader users can reach it (a label around a hidden input is mouse-only).
 * A picture the server wouldn't take isn't chosen, and the picker says why beside its button
 * (it used to be taken, and its upload failed after the merchant was saved).
 */
const MerchantImagePicker: React.FC<MerchantImagePickerProps> = ({ label, onChoose }) => {
  const fieldId = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const pick = (file: File) => {
    const found = imageUploadProblem(file);
    setProblem(found);
    if (!found) onChoose(file);
  };
  return (
    <>
      <FilePickerButton accept={IMAGE_UPLOAD_TYPES.join(',')} onFiles={([file]) => file && pick(file)} aria-describedby={fieldErrorDescribedBy(fieldId, problem)}>
        <Upload size={16} />
        {label}
      </FilePickerButton>
      {/* Said as it appears: the chooser leaves the focus on the button. */}
      <Box aria-live="polite">
        <FieldError fieldId={fieldId} message={problem} />
      </Box>
    </>
  );
};

export default MerchantImagePicker;
