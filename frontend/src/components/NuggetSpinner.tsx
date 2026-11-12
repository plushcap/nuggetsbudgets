import React from 'react';
import { Box, Flex } from '@radix-ui/themes';

interface NuggetSpinnerProps {
  size?: number;
  className?: string;
}

const NuggetSpinner: React.FC<NuggetSpinnerProps> = ({ size = 40, className = '' }) => {
  return (
    <Flex display="inline-flex" position="relative" align="center" justify="center" className={className} style={{ width: size + 16, height: size + 16 }}>
      {/* Spinning circle around the nugget */}
      <Box
        position="absolute" className="animate-spin"
        style={{
          width: size + 16,
          height: size + 16,
          border: `2px solid transparent`,
          borderTop: `2px solid #FFA500`,
          borderRight: `2px solid #FFD700`,
          borderRadius: '50%',
        }}
      />
      
      {/* Bouncing nugget in the center */}
      <Box className="animate-bounce-gentle" style={{ width: size, height: size }}>
        <Box
          position="relative" width="100%" height="100%" className="nugget-shape shadow-md"
          style={{
            background: 'linear-gradient(135deg, #FFD700 0%, #FFA500 50%, #FF8C00 100%)',
            borderRadius: '50% 40% 45% 35%',
            boxShadow: '0 3px 8px rgba(255, 140, 0, 0.3)',
          }}
        >
          {/* Gold highlight */}
          <Box
            position="absolute" className="opacity-70"
            style={{
              top: '10%',
              left: '20%',
              width: '20%',
              height: '20%',
              background: 'linear-gradient(135deg, #FFFF00 0%, #FFD700 100%)',
              borderRadius: '50%'
            }}
          />
          
          {/* Dollar sign */}
          <Box
            position="absolute" className="font-bold"
            style={{
              // The nugget is fixed artwork, the same gold in every theme, so its colours are too
              // (FIXED_ARTWORK in scripts/check-idiom-a.mjs lets them stay inline).
              color: '#78350f',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              fontSize: size * 0.4,
              textShadow: '1px 1px 2px rgba(0,0,0,0.3)'
            }}
          >
            $
          </Box>
        </Box>
      </Box>
    </Flex>
  );
};

export default NuggetSpinner;
