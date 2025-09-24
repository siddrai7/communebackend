// src/middleware/upload.js

import multer from "multer";
import path from "path";
import { nanoid } from "nanoid";
import { createError } from "../utils/errorHandler.js";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let uploadPath = "uploads/";

    if (
      file.fieldname === "buildingImage" ||
      file.fieldname === "masterImage" ||
      file.fieldname === "otherImages"
    ) {
      uploadPath += "buildings/";
    } else if (file.fieldname === "roomImages") {
      uploadPath += "rooms/";
    } else if (file.fieldname === "floorPlanImage") {
      uploadPath += "floor-plans/";
    } else {
      uploadPath += "general/";
    }

    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `${file.fieldname}_${nanoid()}${ext}`;
    cb(null, filename);
  },
});

const fileFilter = (req, file, cb) => {
  // Check file type
  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(createError("FILE_ERROR", "Only image files are allowed"), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024, // 5MB default
  },
});

export default upload;
