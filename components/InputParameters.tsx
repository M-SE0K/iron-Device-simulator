"use client";

import { SlidersHorizontal } from "lucide-react";

export interface InputParameterValues {
  ampOutputPower: string;
  speakerModel: string;
}

interface Props {
  values: InputParameterValues;
  onChange: (values: InputParameterValues) => void;
}

const SPEAKER_MODELS = [
  { value: "", label: "Select model..." },
  { value: "ISD-W4A", label: "ISD-W4A" },
  { value: "ISD-W6B", label: "ISD-W6B" },
  { value: "ISD-T5C", label: "ISD-T5C" },
  { value: "ISD-T8D", label: "ISD-T8D" },
];

export default function InputParameters({ values, onChange }: Props) {
  const handlePowerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/[^0-9.]/g, "");
    onChange({ ...values, ampOutputPower: raw });
  };

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onChange({ ...values, speakerModel: e.target.value });
  };

  return (
    <div className="card">
      <div className="card-header">
        <div className="flex items-center gap-1.5">
          <SlidersHorizontal size={14} className="text-iron-400" />
          <span className="card-title">Input Parameters</span>
        </div>
      </div>

      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* AMP Output Power */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] uppercase tracking-wider font-medium text-iron-400">
            AMP Output Power
          </label>
          <div className="relative flex items-center">
            <input
              type="text"
              inputMode="decimal"
              value={values.ampOutputPower}
              onChange={handlePowerChange}
              placeholder="0"
              className="
                w-full pr-8 pl-3 py-2 rounded-lg border border-iron-200
                bg-white font-mono text-sm text-iron-800
                focus:outline-none focus:ring-1 focus:ring-brand-blue focus:border-brand-blue
                placeholder:text-iron-300
              "
            />
            <span className="absolute right-3 text-xs font-mono font-semibold text-iron-400 pointer-events-none select-none text-blue-500">
              W
            </span>
          </div>
        </div>

        {/* Speaker Model */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] uppercase tracking-wider font-medium text-iron-400">
            Speaker Model
          </label>
          <select
            value={values.speakerModel}
            onChange={handleModelChange}
            className="
              w-full px-3 py-2 rounded-lg border border-iron-200
              bg-white font-mono text-sm text-iron-800
              focus:outline-none focus:ring-1 focus:ring-brand-blue focus:border-brand-blue
              appearance-none cursor-pointer
              bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%239ca3af%22%20d%3D%22M6%208L1%203h10z%22%2F%3E%3C%2Fsvg%3E')]
              bg-no-repeat bg-[right_0.75rem_center]
            "
          >
            {SPEAKER_MODELS.map((m) => (
              <option key={m.value} value={m.value} disabled={m.value === ""}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
