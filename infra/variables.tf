variable "aws_region" {
  description = "Región de AWS donde se crean las instancias. sa-east-1 (San Pablo) es la más cercana a Argentina."
  type        = string
  default     = "sa-east-1"
}

variable "my_ip_cidr" {
  description = "Tu IP pública en formato CIDR (ej: 181.95.10.20/32). Obtenerla con: curl -s https://checkip.amazonaws.com"
  type        = string
}

variable "instance_type" {
  description = "Tipo de instancia. t3.micro está dentro del free tier."
  type        = string
  default     = "t3.micro"
}

variable "name_prefix" {
  description = "Prefijo para nombrar los recursos"
  type        = string
  default     = "so2-bench"
}
