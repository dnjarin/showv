import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Ingresa tu usuario"),
  password: z.string().min(1, "Ingresa tu contraseña"),
});

export const setupSchema = z.object({
  rif: z.string().trim().regex(/^[VEJGPC]-?\d{7,9}(-?\d)?$/i, "RIF inválido (ej: J-12345678-9)"),
  legalName: z.string().trim().min(2, "Razón social requerida"),
  fiscalAddress: z.string().trim().min(5, "Domicilio fiscal requerido"),
  adminFullName: z.string().trim().min(2, "Nombre requerido"),
  adminUsername: z.string().trim().min(3, "Usuario: mínimo 3 caracteres"),
  adminPassword: z.string().min(8, "Contraseña: mínimo 8 caracteres")
  .regex(/[A-Za-z]/, "La contraseña debe incluir letras")
  .regex(/\d/, "La contraseña debe incluir números"),
});