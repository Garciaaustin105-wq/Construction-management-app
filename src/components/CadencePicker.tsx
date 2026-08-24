"use client";

import React from "react";
import {
  SCHEDULE_FREQUENCIES,
  SCHEDULE_FREQUENCY_LABELS,
  INTERVAL_BY_FREQUENCY,
  summarizeLineSchedule,
  type ScheduleFrequency,
} from "@/lib/lawnEstimate";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface CadencePickerProps {
  frequency: string | null;
  intervalWeeks: number;
  daysOfWeek: number[];
  dayOfMonth: number | null;
  startDate: string | null;
  endDate: string | null;
  recurringScheduleId: string | null;
  onChange: (patch: {
    schedule_frequency: string | null;
    schedule_interval_weeks: number;
    schedule_days_of_week: number[];
    schedule_day_of_month: number | null;
    schedule_start_date: string | null;
    schedule_end_date: string | null;
  }) => void;
}

const CadencePicker: React.FC<CadencePickerProps> = ({
  frequency,
  intervalWeeks,
  daysOfWeek,
  dayOfMonth,
  startDate,
  endDate,
  recurringScheduleId,
  onChange,
}) => {
  if (recurringScheduleId) {
    return (
      <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
          Schedule
        </div>
        <div className="inline-flex items-center rounded-full bg-green-50 text-green-700 px-2.5 py-0.5 text-xs font-medium">
          {summarizeLineSchedule({
            schedule_frequency: frequency as ScheduleFrequency | null,
            schedule_interval_weeks: intervalWeeks,
            schedule_days_of_week: daysOfWeek,
            schedule_day_of_month: dayOfMonth,
            schedule_start_date: startDate,
            schedule_end_date: endDate,
          })}
        </div>
        <a
          href={`/lawn/schedules/${recurringScheduleId}`}
          className="text-xs text-blue-600 underline"
        >
          Edit on schedule
        </a>
      </div>
    );
  }

  const handleFrequencyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const freq = e.target.value as ScheduleFrequency | "";
    if (freq === "") {
      onChange({
        schedule_frequency: null,
        schedule_interval_weeks: 1,
        schedule_days_of_week: [],
        schedule_day_of_month: null,
        schedule_start_date: null,
        schedule_end_date: null,
      });
    } else {
      onChange({
        schedule_frequency: freq,
        schedule_interval_weeks: freq === "one-time" ? 1 : INTERVAL_BY_FREQUENCY[freq],
        schedule_days_of_week: freq === "monthly" || freq === "one-time" ? [] : daysOfWeek,
        schedule_day_of_month: freq === "monthly" ? dayOfMonth : null,
        schedule_start_date: startDate,
        schedule_end_date: freq === "one-time" ? null : endDate,
      });
    }
  };

  const toggleDay = (d: number) => {
    if (daysOfWeek.includes(d)) {
      onChange({
        schedule_frequency: frequency,
        schedule_interval_weeks: intervalWeeks,
        schedule_days_of_week: daysOfWeek.filter((day) => day !== d),
        schedule_day_of_month: dayOfMonth,
        schedule_start_date: startDate,
        schedule_end_date: endDate,
      });
    } else {
      onChange({
        schedule_frequency: frequency,
        schedule_interval_weeks: intervalWeeks,
        schedule_days_of_week: [...daysOfWeek, d],
        schedule_day_of_month: dayOfMonth,
        schedule_start_date: startDate,
        schedule_end_date: endDate,
      });
    }
  };

  const handleDayOfMonthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const dom = parseInt(e.target.value, 10);
    onChange({
      schedule_frequency: frequency,
      schedule_interval_weeks: intervalWeeks,
      schedule_days_of_week: daysOfWeek,
      schedule_day_of_month: dom >= 1 && dom <= 28 ? dom : null,
      schedule_start_date: startDate,
      schedule_end_date: endDate,
    });
  };

  const handleStartDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange({
      schedule_frequency: frequency,
      schedule_interval_weeks: intervalWeeks,
      schedule_days_of_week: daysOfWeek,
      schedule_day_of_month: dayOfMonth,
      schedule_start_date: e.target.value,
      schedule_end_date: frequency === "one-time" ? null : endDate,
    });
  };

  const handleEndDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange({
      schedule_frequency: frequency,
      schedule_interval_weeks: intervalWeeks,
      schedule_days_of_week: daysOfWeek,
      schedule_day_of_month: dayOfMonth,
      schedule_start_date: startDate,
      schedule_end_date: e.target.value,
    });
  };

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
        Schedule
      </div>
      <label className="block">
        <span className="text-sm font-medium text-gray-700">Frequency</span>
        <select
          value={frequency ?? ""}
          onChange={handleFrequencyChange}
          className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
        >
          <option value="">None</option>
          {SCHEDULE_FREQUENCIES.map((freq) => (
            <option key={freq} value={freq}>
              {SCHEDULE_FREQUENCY_LABELS[freq]}
            </option>
          ))}
        </select>
      </label>

      {frequency === "weekly" || frequency === "biweekly" ? (
        <div className="mt-2 grid grid-cols-7 gap-2">
          {WEEKDAYS.map((day, index) => (
            <button
              key={index}
              onClick={() => toggleDay(index)}
              className={`${
                daysOfWeek.includes(index)
                  ? "bg-green-600 text-white"
                  : "bg-gray-200 text-gray-900"
              } py-2 rounded-lg text-sm font-semibold flex items-center justify-center`}
            >
              {day}
            </button>
          ))}
        </div>
      ) : null}

      {frequency === "monthly" ? (
        <label className="block mt-2">
          <span className="text-sm font-medium text-gray-700">Day of month</span>
          <input
            type="number"
            min="1"
            max="28"
            value={dayOfMonth ?? ""}
            onChange={handleDayOfMonthChange}
            className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
          />
        </label>
      ) : null}

      {frequency === "one-time" ? (
        <label className="block mt-2">
          <span className="text-sm font-medium text-gray-700">Service date *</span>
          <input
            type="date"
            value={startDate ?? ""}
            onChange={handleStartDateChange}
            className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
          />
        </label>
      ) : (
        <div className="grid grid-cols-2 gap-4 mt-2">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Season start</span>
            <input
              type="date"
              value={startDate ?? ""}
              onChange={handleStartDateChange}
              className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Season end</span>
            <input
              type="date"
              value={endDate ?? ""}
              onChange={handleEndDateChange}
              className="mt-1 block w-full px-3 py-2.5 border border-gray-300 rounded-lg text-base"
            />
          </label>
        </div>
      )}

      {frequency && startDate ? (
        <div className="inline-flex items-center rounded-full bg-green-50 text-green-700 px-2.5 py-0.5 text-xs font-medium mt-2">
          {summarizeLineSchedule({
            schedule_frequency: frequency as ScheduleFrequency | null,
            schedule_interval_weeks: intervalWeeks,
            schedule_days_of_week: daysOfWeek,
            schedule_day_of_month: dayOfMonth,
            schedule_start_date: startDate,
            schedule_end_date: endDate,
          })}
        </div>
      ) : null}
    </div>
  );
};

export default CadencePicker;