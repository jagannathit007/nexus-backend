const UserSlot = require('../models/users_slots');
const PairSlot = require('../models/pair_slot');
const asyncHandler = require("express-async-handler");

function generateTimeSlots(startTime, endTime, duration) {
  const [startHour, startMinute] = startTime.split(':').map(Number);
  const [endHour, endMinute] = endTime.split(':').map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  const slots = [];

  if (start >= end) {
    throw new Error("Start time must be earlier than end time");
  }

  for (let i = start; i < end; i += duration) {
    const h1 = String(Math.floor(i / 60)).padStart(2, '0');
    const m1 = String(i % 60).padStart(2, '0');
    const h2 = String(Math.floor((i + duration) / 60)).padStart(2, '0');
    const m2 = String((i + duration) % 60).padStart(2, '0');

    slots.push({ startTime: `${h1}:${m1}`, endTime: `${h2}:${m2}` });
  }

  return slots;
}

// POST /admin/slots/create
exports.createSlots = asyncHandler(async (req, res) => {
  const { date, startTime, endTime, duration } = req.body;

  if (!date || !startTime || !endTime || !duration) {
    return res.status(400).json({ error: "All fields are required" });
  }

  // Validate time format (HH:MM)
  const timeFormatRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeFormatRegex.test(startTime) || !timeFormatRegex.test(endTime)) {
    return res.status(400).json({ error: "Invalid time format. Use HH:MM" });
  }

  // Validate duration
  const validDurations = [10, 20, 30, 40, 50, 60];
  const durationNum = parseInt(duration);
  if (!validDurations.includes(durationNum)) {
    return res.status(400).json({ error: "Duration must be one of 10, 20, 30, 40, 50, or 60 minutes" });
  }

  try {
    const slots = generateTimeSlots(startTime, endTime, durationNum);
    await UserSlot.deleteOne({ date });
    const created = await UserSlot.create({ date, slots });
    res.status(201).json({ message: "Global slots created", data: created });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// POST /bookings/pair-slots/book
exports.bookPairSlot = asyncHandler(async (req, res) => {
  const { date, slotId, withUserId } = req.body;
  const currentUserId = req.user._id;

  if (!date || !slotId || !withUserId) {
    return res.status(400).json({ error: "Date, slotId, and withUserId are required" });
  }

  if (currentUserId.toString() === withUserId) {
    return res.status(400).json({ error: "Cannot book a slot with yourself" });
  }

  const userSlot = await UserSlot.findOne({ date });
  if (!userSlot) {
    return res.status(404).json({ error: "No slots found for this date" });
  }

  const slot = userSlot.slots.id(slotId);
  if (!slot) {
    return res.status(404).json({ error: "Slot not found" });
  }

  const alreadyBooked = await PairSlot.findOne({
    date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    users: { $in: [currentUserId, withUserId] }
  });

  if (alreadyBooked) {
    return res.status(400).json({ error: "This slot is already booked or pending for one of the users" });
  }

  const booked = await PairSlot.create({
    date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    users: [currentUserId, withUserId],
    isApproved: false,
    requestedBy: currentUserId
  });

  res.status(201).json({ message: "Pair slot request created", data: booked });
});

// PATCH /bookings/pair-slots/approve/:slotId
exports.approvePairSlot = asyncHandler(async (req, res) => {
  const { slotId } = req.params;
  const currentUserId = req.user._id;

  const pairSlot = await PairSlot.findById(slotId);
  if (!pairSlot) {
    return res.status(404).json({ error: "Pair slot not found" });
  }

  if (pairSlot.isApproved) {
    return res.status(400).json({ error: "Slot already approved" });
  }

  if (!pairSlot.users.includes(currentUserId)) {
    return res.status(403).json({ error: "Not authorized to approve this slot" });
  }

  const userSlot = await UserSlot.findOne({ date: pairSlot.date });
  if (!userSlot) {
    return res.status(404).json({ error: "No slots found for this date" });
  }

  const slot = userSlot.slots.find(s =>
    s.startTime === pairSlot.startTime && s.endTime === pairSlot.endTime
  );
  if (!slot) {
    return res.status(404).json({ error: "Slot not found" });
  }

  slot.isBooked = true;
  slot.isApproved = true;
  slot.bookedBy = currentUserId;
  pairSlot.isApproved = true;

  await userSlot.save();
  await pairSlot.save();

  res.json({ message: "Pair slot approved", slot });
});

// DELETE /bookings/pair-slots/cancel/:slotId
exports.cancelPairSlot = asyncHandler(async (req, res) => {
  const { slotId } = req.params;
  const currentUserId = req.user._id;

  const pairSlot = await PairSlot.findById(slotId);
  if (!pairSlot) {
    return res.status(404).json({ error: "Pair slot not found" });
  }

  if (!pairSlot.users.includes(currentUserId)) {
    return res.status(403).json({ error: "Not authorized to cancel this slot" });
  }

  await PairSlot.deleteOne({ _id: slotId });
  res.json({ message: "Pair slot request cancelled" });
});

// GET /bookings/pair-slots/:date/:withUserId
exports.getAvailablePairSlots = asyncHandler(async (req, res) => {
  const { date, withUserId } = req.params;
  const currentUserId = req.user._id;

  if (currentUserId.toString() === withUserId) {
    return res.status(400).json({ error: "Cannot book a slot with yourself" });
  }

  const userSlot = await UserSlot.findOne({ date });
  if (!userSlot) {
    return res.json([]);
  }

  const bookedPairSlots = await PairSlot.find({
    date,
    users: { $in: [currentUserId, withUserId] }
  });

  const bookedSet = new Set(
    bookedPairSlots.map(slot => `${slot.startTime}-${slot.endTime}`)
  );

  const available = userSlot.slots.filter(slot => {
    const key = `${slot.startTime}-${slot.endTime}`;
    return !bookedSet.has(key);
  });

  res.json(available);
});

// GET /pair-slot/booked
exports.getMyPairBookings = asyncHandler(async (req, res) => {
  const myId = req.user._id;
  const slots = await PairSlot.find({ 
    users: myId,
    isApproved: true 
  })
  .sort({ date: -1, startTime: 1 })
  .populate("users", "name email company mobile");

  const formattedSlots = slots.map(slot => {
    const otherUser = slot.users.find(user => user._id.toString() !== myId.toString());
    return {
      _id: slot._id,
      date: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      otherUser, // Return only the other user
    };
  });

  res.json(formattedSlots);
  // res.json(slots);
});

// GET /pair-slot/pending-sent
exports.getPendingSentRequests = asyncHandler(async (req, res) => {
  const myId = req.user._id;
  const slots = await PairSlot.find({ 
    requestedBy: myId,
    isApproved: false 
  })
  .sort({ date: -1, startTime: 1 })
  .populate("users", "name email company mobile");

    const formattedSlots = slots.map(slot => {
    const otherUser = slot.users.find(user => user._id.toString() !== myId.toString());
    return {
      _id: slot._id,
      date: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      otherUser, // Return only the other user
    };
  });

  res.json(formattedSlots);

});

// GET /pair-slot/pending-received
exports.getPendingReceivedRequests = asyncHandler(async (req, res) => {
  const myId = req.user._id;
  const slots = await PairSlot.find({ 
    users: myId,
    isApproved: false,
    requestedBy: { $ne: myId }
  })
  .sort({ date: -1, startTime: 1 })
  .populate("users", "name email company mobile");

  const formattedSlots = slots.map(slot => {
    const otherUser = slot.users.find(user => user._id.toString() !== myId.toString());
    return {
      _id: slot._id,
      date: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      otherUser, // Return only the other user
    };
  });

  res.json(formattedSlots);
  // res.json(slots);
});
